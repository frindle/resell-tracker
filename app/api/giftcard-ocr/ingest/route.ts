import { NextResponse } from 'next/server';
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { resolveExtensionUserId } from '@/lib/extensionAuth';
import { giftCardOcrGate, readGiftCardImage } from '@/lib/giftCardOcr';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { sniffUpload, uploadProblem } from '@/lib/uploadSniff';
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

  const buffer = Buffer.from(await file.arrayBuffer());
  // File type comes from the bytes, never from the client's name or Content-Type.
  const bad = uploadProblem(buffer);
  if (bad) return Response.json({ error: bad }, { status: 400 });
  const sniffed = sniffUpload(buffer)!;
  const filename = `${randomUUID()}${sniffed.ext}`;

  await mkdir(UNASSIGNED_DIR, { recursive: true });
  await writeFile(join(UNASSIGNED_DIR, filename), buffer);

  const attachment = await prisma.orderAttachment.create({
    data: {
      orderId: null,
      userId: uid,
      filename,
      originalName: file.name,
      mimeType: sniffed.mime,
    },
  });

  const attachmentId = attachment.id;

  if (sniffed.mime.startsWith('image/')) {
    try {
      const thumb = await makeUnrotatedThumbnail(buffer, sniffed.mime);
      await writeFile(unassignedThumbPath(filename), thumb);
    } catch (err) {
      console.error(`thumbnail generation failed for ${filename}:`, err);
    }
  }

  const ocrResult = await readGiftCardImage(new File([buffer], filename, { type: sniffed.mime }));
  const candidates = ocrResult.candidates.map(c => c.pin);

  return NextResponse.json({ ok: true, attachmentId, candidates });
}
