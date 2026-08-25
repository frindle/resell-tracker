/**
 * Browser-renderable JPEG of one attachment, for the OCR review screen.
 *
 * The existing per-order attachment endpoint serves the original bytes with
 * their original mime type, which for an iPhone upload is HEIC — no browser
 * renders that, and a review screen you cannot see the card on is useless.
 * This converts (same heic-convert + sharp path the unassigned-photo
 * thumbnailer already uses) and applies the attachment's saved rotation, so the
 * displayed image is in the same orientation the candidate regions were
 * rotated into by the analyse route.
 *
 * DORMANT: 404s unless GIFTCARD_OCR_ENABLED === 'true'.
 */

import { NextRequest } from 'next/server';
import { readFile } from 'fs/promises';
import { join } from 'path';
import sharp from 'sharp';
import convertHeic from 'heic-convert';
import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { giftCardOcrGate } from '@/lib/giftCardOcr';

const FILES_DIR = '/data/files';

// Big enough to read a printed PIN after the browser scales it down, small
// enough not to ship a 12 MP original over the LAN on every render.
const MAX_EDGE = 2200;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; attachmentId: string }> },
) {
  const gate = giftCardOcrGate();
  if (gate) return gate;

  const userId = await getSessionUserId();
  if (userId == null) return new Response('Not found', { status: 404 });

  const { id, attachmentId } = await params;
  const orderId = parseInt(id);

  const order = await prisma.order.findFirst({ where: { id: orderId, userId }, select: { id: true } });
  if (!order) return new Response('Not found', { status: 404 });

  const attachment = await prisma.orderAttachment.findFirst({
    where: { id: parseInt(attachmentId), orderId },
  });
  if (!attachment) return new Response('Not found', { status: 404 });

  try {
    const buffer = await readFile(join(FILES_DIR, String(orderId), attachment.filename));
    // sharp's prebuilt binary cannot decode real HEIC (licensing), so HEIC goes
    // through heic-convert's WASM libheif first — same reason and same approach
    // as the unassigned-attachment thumbnailer.
    const source = attachment.mimeType === 'image/heic' || attachment.mimeType === 'image/heif'
      ? Buffer.from(await convertHeic({ buffer, format: 'JPEG', quality: 0.92 }))
      : buffer;

    // .rotate() with no angle normalises EXIF orientation (which is what the
    // OCR service also does); the user's saved rotation is a separate second
    // pass, because passing an explicit angle would replace the EXIF handling
    // rather than compound with it.
    const normalised = await sharp(source).rotate().toBuffer();
    const oriented = attachment.rotation
      ? await sharp(normalised).rotate(attachment.rotation).toBuffer()
      : normalised;
    const out = await sharp(oriented)
      .resize(MAX_EDGE, MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 88 })
      .toBuffer();

    return new Response(new Uint8Array(out), {
      headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' },
    });
  } catch {
    return new Response('File not found', { status: 404 });
  }
}
