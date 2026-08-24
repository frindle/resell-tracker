import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { resolveExtensionUserId } from '@/lib/extensionAuth';
import { requireOrderUnlocked } from '@/lib/orderLock';
import { NextRequest } from 'next/server';
import { readFile, unlink, rename, mkdir } from 'fs/promises';
import { join } from 'path';
import sharp from 'sharp';
import convertHeic from 'heic-convert';

const FILES_DIR = '/data/files';
const UNASSIGNED_DIR = join(FILES_DIR, 'unassigned');

// Grid thumbnails: the triage grid was shipping every unassigned photo at
// full original size (often several MB each, more for HEIC) just to render
// small squares -- 30-40 of those loading/decoding at once is exactly what
// was making the page slow and, per Penn, possibly leaking memory. sharp's
// prebuilt binary can't decode real HEIC (licensing -- it only lists .avif
// under the heif format, confirmed by testing against real HEIC files: fails
// with "Support for this compression format has not been built in"), so
// HEIC goes through heic-convert (WASM libheif, no native licensing issue)
// to get a JPEG buffer first, then sharp resizes whatever we've got.
const THUMB_SIZE = 320;

async function makeThumbnail(buffer: Buffer, mimeType: string): Promise<Buffer> {
  const source = mimeType === 'image/heic' || mimeType === 'image/heif'
    ? Buffer.from(await convertHeic({ buffer, format: 'JPEG', quality: 0.9 }))
    : buffer;
  return sharp(source).resize(THUMB_SIZE, THUMB_SIZE, { fit: 'cover' }).jpeg({ quality: 78 }).toBuffer();
}

async function findUnassigned(attachmentId: number, uid: number) {
  return prisma.orderAttachment.findFirst({ where: { id: attachmentId, orderId: null, userId: uid } });
}

// Preview the photo while triaging it (same shape as the per-order
// attachment GET, just reading from the unassigned/ directory instead of
// an order-numbered one). ?thumb=1 returns a small resized JPEG for grid
// display instead of the full original -- see makeThumbnail() above.
export async function GET(req: NextRequest, { params }: { params: Promise<{ attachmentId: string }> }) {
  const sessionUid = await getSessionUserId();
  const uid = resolveExtensionUserId(req, sessionUid);
  if (uid == null) return Response.json({ error: 'not authenticated' }, { status: 401 });

  const { attachmentId } = await params;
  const attachment = await findUnassigned(parseInt(attachmentId), uid);
  if (!attachment) return new Response('Not found', { status: 404 });

  const wantsThumb = req.nextUrl.searchParams.get('thumb') === '1';

  try {
    const buffer = await readFile(join(UNASSIGNED_DIR, attachment.filename));

    if (wantsThumb && attachment.mimeType.startsWith('image/')) {
      try {
        const thumb = await makeThumbnail(buffer, attachment.mimeType);
        return new Response(new Uint8Array(thumb), {
          headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' },
        });
      } catch {
        // Fall through to the full image if thumbnailing fails for any
        // reason (e.g. an unusual format) -- a slow load beats a broken one.
      }
    }

    return new Response(buffer, {
      headers: {
        'Content-Type': attachment.mimeType,
        'Content-Disposition': `inline; filename="${attachment.originalName}"`,
        'Cache-Control': 'private, max-age=86400',
      },
    });
  } catch {
    return new Response('File not found', { status: 404 });
  }
}

// Discard a photo without assigning it (blurry shot, duplicate, etc).
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ attachmentId: string }> }) {
  const sessionUid = await getSessionUserId();
  const uid = resolveExtensionUserId(req, sessionUid);
  if (uid == null) return Response.json({ error: 'not authenticated' }, { status: 401 });

  const { attachmentId } = await params;
  const attachment = await findUnassigned(parseInt(attachmentId), uid);
  if (!attachment) return new Response('Not found', { status: 404 });

  try { await unlink(join(UNASSIGNED_DIR, attachment.filename)); } catch { /* already gone */ }
  await prisma.orderAttachment.delete({ where: { id: attachment.id } });
  return Response.json({ ok: true });
}

// Sort this photo onto a real order: moves the file into that order's own
// attachment directory (so it reads identically to a direct per-order
// upload afterward -- GET/DELETE at /api/orders/[id]/attachments/[id]
// construct their path from orderId + filename, so the file has to
// actually live there, not just have its DB row repointed) and clears
// orderId to attach it.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ attachmentId: string }> }) {
  const sessionUid = await getSessionUserId();
  const uid = resolveExtensionUserId(req, sessionUid);
  if (uid == null) return Response.json({ error: 'not authenticated' }, { status: 401 });

  const { attachmentId } = await params;
  const attachment = await findUnassigned(parseInt(attachmentId), uid);
  if (!attachment) return new Response('Not found', { status: 404 });

  let body: { orderId?: number };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'invalid json' }, { status: 400 });
  }
  const orderId = body.orderId;
  if (!orderId || !Number.isInteger(orderId)) {
    return Response.json({ error: 'orderId required' }, { status: 400 });
  }

  const lockErr = await requireOrderUnlocked(orderId, uid);
  if (lockErr) return lockErr;

  const order = await prisma.order.findFirst({ where: { id: orderId, userId: uid }, select: { id: true } });
  if (!order) return Response.json({ error: 'order not found' }, { status: 404 });

  const orderDir = join(FILES_DIR, String(orderId));
  await mkdir(orderDir, { recursive: true });
  await rename(join(UNASSIGNED_DIR, attachment.filename), join(orderDir, attachment.filename));

  const updated = await prisma.orderAttachment.update({
    where: { id: attachment.id },
    data: { orderId },
  });
  return Response.json(updated);
}
