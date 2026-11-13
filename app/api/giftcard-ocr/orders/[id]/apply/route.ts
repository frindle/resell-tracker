/**
 * Flow B write path: persist codes a human accepted on the review screen.
 *
 * The invariant this route exists to enforce is that **OCR never writes a code
 * autonomously**. Nothing here reads from the OCR service; it only accepts a
 * body the user submitted from the review screen, exactly as they left it after
 * correcting it. The `suggested` field is compared against the submitted value
 * purely to record whether they changed it — it is never itself stored as the
 * code.
 *
 * DORMANT: 404s unless GIFTCARD_OCR_ENABLED === 'true'.
 */

import { NextRequest } from 'next/server';
import { linkPhotoToCard } from '@/lib/cardcenterImagesDeps';
import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { requireOrderUnlocked } from '@/lib/orderLock';
import { giftCardOcrGate } from '@/lib/giftCardOcr';
import { applyAcceptedCodes, type AcceptedCode } from '@/lib/giftCardOcrApply';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = giftCardOcrGate();
  if (gate) return gate;

  try {
    const userId = await getSessionUserId();
    if (userId == null) return Response.json({ error: 'not authenticated' }, { status: 401 });

    const { id } = await params;
    const orderId = parseInt(id);

    const lockErr = await requireOrderUnlocked(orderId, userId);
    if (lockErr) return lockErr;

    const order = await prisma.order.findFirst({ where: { id: orderId, userId }, select: { id: true } });
    if (!order) return Response.json({ error: 'Not found' }, { status: 404 });

    const body = await req.json() as { codes?: AcceptedCode[] };
    const codes = Array.isArray(body.codes) ? body.codes : [];
    if (!codes.length) return Response.json({ error: 'no codes submitted' }, { status: 400 });

    const { created, skipped } = await applyAcceptedCodes({
      existingNumbers: async () => (await prisma.giftCard.findMany({ where: { orderId }, select: { cardNumber: true } })).map(c => c.cardNumber),
      findAttachment: (attachmentId) => prisma.orderAttachment.findFirst({ where: { id: attachmentId, orderId }, select: { id: true, giftCardId: true } }),
      createCard: (data) => prisma.giftCard.create({ data: { orderId, ...data } }),
      linkAttachment: (attachmentId, giftCardId) => linkPhotoToCard(attachmentId, giftCardId),
    }, codes);

    return Response.json({ ok: true, created, skipped });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
