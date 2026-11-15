import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { NextRequest } from 'next/server';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { setAttachmentCards } from '@/lib/photoCardLinks';
import { linkOrderPhotos } from '@/lib/cardcenterImagesDeps';
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

// PATCH { giftCardIds?: number[], receipt?: boolean | null } -- giftCardIds sets
// which of this order's gift cards a photo shows (empty array unlinks); photos
// linked to a card are what gets sent to CardCenter for that card. receipt marks
// the photo a receipt (linked to the cards it names, never sent) or a card
// photo, then matches the order's photos again so the ticks fill in.
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

  const body = await req.json().catch(() => null) as { giftCardIds?: unknown; receipt?: unknown } | null;
  const hasCards = !!body && 'giftCardIds' in body;
  const hasReceipt = !!body && 'receipt' in body;
  if (!hasCards && !hasReceipt) return Response.json({ error: 'giftCardIds or receipt required' }, { status: 400 });
  if (hasReceipt && body!.receipt !== true && body!.receipt !== false && body!.receipt !== null) {
    return Response.json({ error: 'receipt must be true, false or null' }, { status: 400 });
  }
  if (hasReceipt) {
    await prisma.orderAttachment.update({ where: { id: attachment.id }, data: { receipt: body!.receipt as boolean | null } });
  }
  if (!hasCards) {
    await linkOrderPhotos(orderId);
    const now = await prisma.orderAttachment.findUnique({
      where: { id: attachment.id },
      select: { receipt: true, giftCardId: true, cardLinks: { select: { giftCardId: true } } },
    });
    const giftCardIds = [...new Set([...(now?.giftCardId != null ? [now.giftCardId] : []), ...(now?.cardLinks ?? []).map(l => l.giftCardId)])];
    return Response.json({ id: attachment.id, receipt: now?.receipt ?? null, giftCardIds, giftCardId: now?.giftCardId ?? null });
  }
  const r = await setAttachmentCards({
    orderCardIds: async oid => (await prisma.giftCard.findMany({ where: { orderId: oid }, select: { id: true } })).map(c => c.id),
    replace: async (aid, ids, first) => {
      await prisma.$transaction([
        prisma.giftCardPhoto.deleteMany({ where: { attachmentId: aid } }),
        ...(ids.length ? [prisma.giftCardPhoto.createMany({ data: ids.map(giftCardId => ({ giftCardId, attachmentId: aid })) })] : []),
        prisma.orderAttachment.update({ where: { id: aid }, data: { giftCardId: first } }),
      ]);
    },
  }, attachment.id, orderId, body.giftCardIds);
  if (!r.ok) return Response.json({ error: r.error }, { status: 400 });
  return Response.json({ id: attachment.id, giftCardIds: r.giftCardIds, giftCardId: r.giftCardIds[0] ?? null });
}
