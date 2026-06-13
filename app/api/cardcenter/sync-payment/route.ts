import { prisma, getSetting } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { getCcToken, getPaymentDetail } from '@/lib/cardcenter';
import { NextRequest } from 'next/server';

// Fetch a CardCenter payment and distribute paid amounts across orders
// by matching listing.giftCard.id → GiftCard.ccGiftCardId → Order.bgPaidAmount
export async function POST(req: NextRequest) {
  const userId = await getSessionUserId();
  const uid = userId ?? null;
  const { paymentId } = await req.json() as { paymentId: string };
  if (!paymentId) return new Response('Missing paymentId', { status: 400 });

  const [emailSetting, passwordSetting] = await Promise.all([
    getSetting(uid, 'cc_email'),
    getSetting(uid, 'cc_password'),
  ]);
  if (!emailSetting?.value || !passwordSetting?.value) {
    return new Response('CardCenter credentials not configured', { status: 400 });
  }

  const token = await getCcToken(emailSetting.value, passwordSetting.value);
  const payment = await getPaymentDetail(token, paymentId);

  const listings = payment.listings ?? [];
  if (listings.length === 0) {
    return Response.json({ matched: 0, message: 'No listings in payment' });
  }

  // Build map of ccGiftCardId (string) → amount paid
  const amountByCardId = new Map<string, number>();
  for (const l of listings) {
    amountByCardId.set(String(l.listing.giftCard.id), l.amount);
  }

  // Find our gift cards that match
  const giftCards = await prisma.giftCard.findMany({
    where: {
      ccGiftCardId: { in: Array.from(amountByCardId.keys()) },
      order: { userId: uid },
    },
    select: { id: true, ccGiftCardId: true, orderId: true },
  });

  if (giftCards.length === 0) {
    return Response.json({ matched: 0, message: 'No matching gift cards found — ensure CC IDs are set on gift cards' });
  }

  // Sum amounts per order
  const amountByOrderId = new Map<number, number>();
  for (const gc of giftCards) {
    if (!gc.ccGiftCardId) continue;
    const amount = amountByCardId.get(gc.ccGiftCardId) ?? 0;
    amountByOrderId.set(gc.orderId, (amountByOrderId.get(gc.orderId) ?? 0) + amount);
  }

  // Update bgPaidAmount on each matched order
  await Promise.all(
    Array.from(amountByOrderId.entries()).map(([orderId, amount]) =>
      prisma.order.updateMany({
        where: { id: orderId, locked: false },
        data: { bgPaidAmount: amount },
      })
    )
  );

  return Response.json({ matched: amountByOrderId.size, total: payment.amount });
}
