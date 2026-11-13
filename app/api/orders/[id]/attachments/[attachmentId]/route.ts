import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { NextRequest } from 'next/server';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { safeServeHeaders, sniffUpload } from '@/lib/uploadSniff';

const FILES_DIR = '/data/files';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string; attachmentId: string }> }) {
  const userId = await getSessionUserId();
  const { id, attachmentId } = await params;
  const orderId = parseInt(id);

  const order = await prisma.order.findFirst({
    where: { id: orderId, ...(userId ? { userId } : { userId: null }) },
    select: { id: true },
  });
  if (!order) return new Response('Not found', { status: 404 });

  const attachment = await prisma.orderAttachment.findFirst({
    where: { id: parseInt(attachmentId), orderId },
  });
  if (!attachment) return new Response('Not found', { status: 404 });

  try {
    const buffer = await readFile(join(FILES_DIR, String(orderId), attachment.filename));
    return new Response(buffer, {
      headers: { ...safeServeHeaders(sniffUpload(buffer), attachment.originalName), 'Cache-Control': 'private, max-age=86400' },
    });
  } catch {
    return new Response('File not found', { status: 404 });
  }
}

// PATCH { giftCardId: number | null } -- link a photo to one of this order's gift
// cards (or unlink with null). Photos linked to a card are what gets sent to
// CardCenter for that card.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string; attachmentId: string }> }) {
  const userId = await getSessionUserId();
  const { id, attachmentId } = await params;
  const orderId = parseInt(id);

  const order = await prisma.order.findFirst({
    where: { id: orderId, ...(userId ? { userId } : { userId: null }) },
    select: { id: true },
  });
  if (!order) return new Response('Not found', { status: 404 });

  const attachment = await prisma.orderAttachment.findFirst({
    where: { id: parseInt(attachmentId), orderId },
    select: { id: true },
  });
  if (!attachment) return new Response('Not found', { status: 404 });

  const body = await req.json().catch(() => null) as { giftCardId?: number | null } | null;
  if (!body || !('giftCardId' in body)) return Response.json({ error: 'giftCardId required' }, { status: 400 });
  const giftCardId = body.giftCardId;
  if (giftCardId !== null && !Number.isInteger(giftCardId)) return Response.json({ error: 'giftCardId must be an integer or null' }, { status: 400 });
  if (giftCardId !== null) {
    const card = await prisma.giftCard.findFirst({ where: { id: giftCardId, orderId }, select: { id: true } });
    if (!card) return Response.json({ error: 'Gift card is not on this order' }, { status: 400 });
  }

  const updated = await prisma.orderAttachment.update({ where: { id: attachment.id }, data: { giftCardId } });
  return Response.json(updated);
}
