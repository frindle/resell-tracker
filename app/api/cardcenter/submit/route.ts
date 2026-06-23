import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { getCcToken, submitCards } from '@/lib/cardcenter';
import { NextRequest } from 'next/server';

export async function POST(req: NextRequest) {
  try {
    const userId = await getSessionUserId();
    const { orderId } = await req.json() as { orderId: number };

    const [emailSetting, passwordSetting] = await Promise.all([
      prisma.setting.findFirst({ where: { userId, key: 'cc_email' } }),
      prisma.setting.findFirst({ where: { userId, key: 'cc_password' } }),
    ]);
    if (!emailSetting?.value || !passwordSetting?.value) {
      return Response.json({ error: 'CardCenter credentials not configured in Settings' }, { status: 400 });
    }

    const cards = await prisma.giftCard.findMany({ where: { orderId, order: { userId } }, orderBy: { createdAt: 'asc' } });
    if (!cards.length) return Response.json({ error: 'No gift cards on this order' }, { status: 400 });

    const unsubmitted = cards.filter(c => !c.ccSubmittedAt);
    if (!unsubmitted.length) {
      return Response.json({ submitted: 0, duplicate: 0, failed: 0, alreadyDone: true });
    }

    const token = await getCcToken(emailSetting.value, passwordSetting.value);
    const result = await submitCards(token, unsubmitted.map(c => ({
      id: c.id,
      code: c.cardNumber,
      merchant: c.merchant,
      value: c.value,
      ccReservationId: c.ccReservationId,
    })));

    const doneIds = [...result.submitted, ...result.duplicate];
    if (doneIds.length) {
      await prisma.giftCard.updateMany({
        where: { id: { in: doneIds } },
        data: { ccSubmittedAt: new Date() },
      });
    }

    // Populate ccGiftCardId + ccPurchasePrice by matching card code suffix
    // from submission detail. Persisting the per-card payout lets us show
    // it on the order's gift-card row without re-hitting the CardCenter API.
    if (result.ccGiftCardIds?.length) {
      for (const card of unsubmitted) {
        const match = result.ccGiftCardIds.find(sc =>
          card.cardNumber.endsWith(sc.code.replace(/^…/, ''))
        );
        if (match) {
          await prisma.giftCard.update({
            where: { id: card.id },
            data: {
              ccGiftCardId: match.ccGiftCardId,
              ccPurchasePrice: match.purchasePrice ?? null,
            },
          });
        }
      }
      const firstReceivedOn = result.ccGiftCardIds[0]?.paymentReceivedOn;
      const orderUpdate: Record<string, unknown> = {};
      if (firstReceivedOn) orderUpdate.overdueAt = new Date(firstReceivedOn);
      if (result.paymentName) orderUpdate.groupReferenceId = result.paymentName;
      // result.salePrice is the sum of cards submitted in *this* call.
      // When the user submits cards one at a time, the previous call already
      // wrote a salePrice for the first card — replacing it here would lose
      // that. If the order has prior CardCenter submissions, add to the
      // existing salePrice instead.
      if (result.salePrice) {
        const hadPriorSubmissions = cards.some(c => c.ccSubmittedAt != null);
        if (hadPriorSubmissions) {
          const o = await prisma.order.findUnique({ where: { id: orderId }, select: { salePrice: true } });
          orderUpdate.salePrice = (o?.salePrice ?? 0) + result.salePrice;
        } else {
          orderUpdate.salePrice = result.salePrice;
        }
      }
      if (Object.keys(orderUpdate).length) {
        await prisma.order.update({ where: { id: orderId }, data: orderUpdate });
      }
    }

    return Response.json({
      submitted: result.submitted.length,
      duplicate: result.duplicate.length,
      failed: result.failed.length,
      rawError: result.rawError,
    });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
