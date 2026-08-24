import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { resolveExtensionUserId } from '@/lib/extensionAuth';
import { requireOrderUnlocked } from '@/lib/orderLock';
import { NextRequest } from 'next/server';
import { readFile, unlink, rename, mkdir } from 'fs/promises';
import { join } from 'path';

const FILES_DIR = '/data/files';
const UNASSIGNED_DIR = join(FILES_DIR, 'unassigned');

async function findUnassigned(attachmentId: number, uid: number) {
  return prisma.orderAttachment.findFirst({ where: { id: attachmentId, orderId: null, userId: uid } });
}

// Preview the photo while triaging it (same shape as the per-order
// attachment GET, just reading from the unassigned/ directory instead of
// an order-numbered one).
export async function GET(req: NextRequest, { params }: { params: Promise<{ attachmentId: string }> }) {
  const sessionUid = await getSessionUserId();
  const uid = resolveExtensionUserId(req, sessionUid);
  if (uid == null) return Response.json({ error: 'not authenticated' }, { status: 401 });

  const { attachmentId } = await params;
  const attachment = await findUnassigned(parseInt(attachmentId), uid);
  if (!attachment) return new Response('Not found', { status: 404 });

  try {
    const buffer = await readFile(join(UNASSIGNED_DIR, attachment.filename));
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
