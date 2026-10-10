import { NextResponse } from 'next/server';
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { resolveExtensionUserId } from '@/lib/extensionAuth';
import { giftCardOcrGate, readGiftCardImage } from '@/lib/giftCardOcr';
import { writeFile, mkdir } from 'fs/promises';
import { join, extname } from 'path';
import { randomUUID } from 'crypto';
import { makeUnrotatedThumbnail, unassignedThumbPath } from '@/lib/thumbnail';

const FILES_DIR = '/data/files';
const UNASSIGNED_DIR = join(FILES_DIR, 'unassigned');

export async function POST(req: NextRequest) {
  // Gate: GIFTCARD_OCR_ENABLED must be 'true' (checked by giftCardOcrGate) before any auth/body work
  const gate = giftCardOcrGate();
  if (gate) return gate;

  const sessionUid = await getSessionUserId();
  const uid = resolveExtensionUserId(req, sessionUid);
  if (uid == null) return Response.json({ error: 'not authenticated' }, { status: 401 });

  const formData = await req.formData();
  const file = formData.get('file');
  if (!file || !(file instanceof File)) return Response.json({ error: 'missing file field' }, { status: 400 });

  const ext = extname(file.name) || '';
  const filename = `${randomUUID()}${ext}`;
  const buffer = Buffer.from(await file.arrayBuffer());

  await mkdir(UNASSIGNED_DIR, { recursive: true });
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

  const attachmentId = attachment.id;

  if (file.type.startsWith('image/')) {
    try {
      const thumb = await makeUnrotatedThumbnail(buffer, file.type);
      await writeFile(unassignedThumbPath(filename), thumb);
    } catch (err) {
      console.error(`thumbnail generation failed for ${filename}:`, err);
    }
  }

  const ocrResult = await readGiftCardImage(file);
  const candidates = ocrResult.candidates.map(c => c.pin);

  return NextResponse.json({ ok: true, attachmentId, candidates });
}
