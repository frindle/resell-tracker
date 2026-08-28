import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { resolveExtensionUserId } from '@/lib/extensionAuth';
import { NextRequest } from 'next/server';
import { writeFile, mkdir } from 'fs/promises';
import { join, extname } from 'path';
import { randomUUID } from 'crypto';
import { makeUnrotatedThumbnail, unassignedThumbPath, UNASSIGNED_THUMB_DIR } from '@/lib/thumbnail';

// Bulk photo upload: lands each file as an unassigned OrderAttachment
// (orderId null) rather than requiring an order to be picked per-file up
// front. Sort onto orders afterward via /orders/sort-assign, same pattern
// as the existing single-order attachment upload but without the order
// context. See prisma/migrations/20260823192500_*.
const FILES_DIR = '/data/files';
const UNASSIGNED_DIR = join(FILES_DIR, 'unassigned');

export async function POST(req: NextRequest) {
  const sessionUid = await getSessionUserId();
  const uid = resolveExtensionUserId(req, sessionUid);
  if (uid == null) return Response.json({ error: 'not authenticated' }, { status: 401 });

  const formData = await req.formData();
  const files = formData.getAll('files').filter((f): f is File => f instanceof File);
  if (files.length === 0) return Response.json({ error: 'no files' }, { status: 400 });

  await mkdir(UNASSIGNED_DIR, { recursive: true });
  await mkdir(UNASSIGNED_THUMB_DIR, { recursive: true });

  const created = [];
  for (const file of files) {
    const ext = extname(file.name) || '';
    const filename = `${randomUUID()}${ext}`;
    const buffer = Buffer.from(await file.arrayBuffer());
    await writeFile(join(UNASSIGNED_DIR, filename), buffer);

    const attachment = await prisma.orderAttachment.create({
      data: {
        orderId: null,
        userId: uid,
        filename,
        originalName: file.name,
        mimeType: file.type || 'application/octet-stream',
      },
    });

    // Generate the unrotated 320x320 thumbnail ONCE here at import time and
    // cache it next to the original, so the triage grid's ?thumb=1 reads are
    // a cheap small-JPEG read (+ optional rotation pass) instead of a fresh
    // HEIC decode + resize per page load. User rotation is deliberately NOT
    // baked in -- it's applied fresh at read time. A failure here must not
    // fail the upload: the read path falls back to generating fresh from
    // the original when the cached thumbnail is missing.
    if (attachment.mimeType.startsWith('image/')) {
      try {
        const thumb = await makeUnrotatedThumbnail(buffer, attachment.mimeType);
        await writeFile(unassignedThumbPath(filename), thumb);
      } catch (err) {
        console.error(`thumbnail generation failed for ${filename}:`, err);
      }
    }

    created.push(attachment);
  }

  return Response.json({ created: created.length, attachments: created });
}
