import { prisma, getSetting } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { getCcToken, getPaymentDetail, ccJson } from '@/lib/cardcenter';

const BASE_URL = 'https://cardcenter.cc';

async function processPayment(
  token: string,
  paymentId: string,
  uid: string | null,
  processed: Set<string>,
): Promise<number> {
  if (processed.has(paymentId)) return 0;
  processed.add(paymentId);

  const payment = await getPaymentDetail(token, paymentId);
  const listings = payment.listings ?? [];
  if (listings.length === 0) return 0;

  const amountByCardId = new Map<string, number>();
  for (const l of listings) {
    amountByCardId.set(String(l.listing.giftCard.id), l.amount);
  }

  const giftCards = await prisma.giftCard.findMany({
    where: { ccGiftCardId: { in: Array.from(amountByCardId.keys()) }, order: { userId: uid } },
    select: { ccGiftCardId: true, orderId: true },
  });
  if (giftCards.length === 0) return 0;

  const overdueAt = payment.receivedOn ? new Date(payment.receivedOn) : null;
  const amountByOrderId = new Map<number, number>();
  for (const gc of giftCards) {
    if (!gc.ccGiftCardId) continue;
    const amount = amountByCardId.get(gc.ccGiftCardId) ?? 0;
    amountByOrderId.set(gc.orderId, (amountByOrderId.get(gc.orderId) ?? 0) + amount);
  }

  await Promise.all(
    Array.from(amountByOrderId.entries()).map(([orderId, amount]) =>
      prisma.order.updateMany({
        where: { id: orderId, locked: false },
        data: { bgPaidAmount: amount, groupReferenceId: payment.name, ...(overdueAt ? { overdueAt } : {}) },
      })
    )
  );
  return amountByOrderId.size;
}

export async function POST() {
  try {
    const userId = await getSessionUserId();
    const uid = userId ?? null;

    const [emailSetting, passwordSetting] = await Promise.all([
      getSetting(uid, 'cc_email'),
      getSetting(uid, 'cc_password'),
    ]);
    if (!emailSetting?.value || !passwordSetting?.value) {
      return Response.json({ updated: 0, message: 'CardCenter credentials not configured' });
    }

    const token = await getCcToken(emailSetting.value, passwordSetting.value);
    const processed = new Set<string>();
    let totalUpdated = 0;

    // Pass 1: process payments already linked to orders
    const orders = await prisma.order.findMany({
      where: { userId: uid, groupReferenceId: { not: null } },
      select: { groupReferenceId: true },
    });
    for (const paymentId of [...new Set(orders.map(o => o.groupReferenceId!))]) {
      try { totalUpdated += await processPayment(token, paymentId, uid, processed); } catch { /* skip */ }
    }

    // Pass 2: fetch all CC payments and match unlinked orders by ccGiftCardId
    let sellerId = '';
    try {
      const rRes = await fetch(`${BASE_URL}/Api/Reservations`, { headers: { Authorization: `Bearer ${token}` } });
      if (rRes.ok) {
        const rData = await rRes.json() as { items?: { seller: { id: number } }[] } | { seller: { id: number } }[];
        const items = Array.isArray(rData) ? rData : (rData.items ?? []);
        if (items.length > 0) sellerId = String(items[0].seller.id);
      }
    } catch { /* no sellerId */ }

    if (sellerId) {
      for (const apiStatus of ['Scheduled', 'Sent', 'Completed']) {
        try {
          const params = new URLSearchParams({ status: apiStatus, paidTo: sellerId });
          const res = await fetch(`${BASE_URL}/Api/Payments?${params}`, { headers: { Authorization: `Bearer ${token}` } });
          if (!res.ok) continue;
          const data = await ccJson<{ items?: { name: string }[] }>(res, `Payments?status=${apiStatus}`);
          for (const p of data.items ?? []) {
            try { totalUpdated += await processPayment(token, p.name, uid, processed); } catch { /* skip */ }
          }
        } catch { /* skip status */ }
      }
    }

    return Response.json({ updated: totalUpdated });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
