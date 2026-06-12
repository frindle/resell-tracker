import { prisma, getSetting } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { getCcToken, getPaymentDetail } from '@/lib/cardcenter';

// Bulk sync: find all CardCenter orders with a groupReferenceId (payment ID) and distribute payouts
export async function POST() {
  const userId = await getSessionUserId();
  const uid = userId ?? null;

  const [emailSetting, passwordSetting] = await Promise.all([
    getSetting(uid, 'cc_email'),
    getSetting(uid, 'cc_password'),
  ]);
  if (!emailSetting?.value || !passwordSetting?.value) {
    return Response.json({ updated: 0, message: 'CardCenter credentials not configured' });
  }

  // Find all orders with a CardCenter buyer and a payment ID set
  const orders = await prisma.order.findMany({
    where: {
      userId: uid,
      groupReferenceId: { not: null },
      buyer: { name: { contains: 'CardCenter' } },
    },
    select: { id: true, groupReferenceId: true },
  });

  const paymentIds = [...new Set(orders.map(o => o.groupReferenceId!))];
  if (paymentIds.length === 0) return Response.json({ updated: 0 });

  const token = await getCcToken(emailSetting.value, passwordSetting.value);

  let totalUpdated = 0;

  for (const paymentId of paymentIds) {
    try {
      const payment = await getPaymentDetail(token, paymentId);
      const listings = payment.listings ?? [];
      if (listings.length === 0) continue;

      const amountByCardId = new Map<string, number>();
      for (const l of listings) {
        amountByCardId.set(String(l.listing.giftCard.id), l.amount);
      }

      const giftCards = await prisma.giftCard.findMany({
        where: {
          ccGiftCardId: { in: Array.from(amountByCardId.keys()) },
          order: { userId: uid },
        },
        select: { ccGiftCardId: true, orderId: true },
      });

      const amountByOrderId = new Map<number, number>();
      for (const gc of giftCards) {
        if (!gc.ccGiftCardId) continue;
        const amount = amountByCardId.get(gc.ccGiftCardId) ?? 0;
        amountByOrderId.set(gc.orderId, (amountByOrderId.get(gc.orderId) ?? 0) + amount);
      }

      await Promise.all(
        Array.from(amountByOrderId.entries()).map(([orderId, amount]) =>
          prisma.order.update({ where: { id: orderId }, data: { bgPaidAmount: amount } })
        )
      );
      totalUpdated += amountByOrderId.size;
    } catch { /* skip failed payments, continue with others */ }
  }

  return Response.json({ updated: totalUpdated });
}
