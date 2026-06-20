import { prisma, getSetting } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { getCcToken, getPaymentDetail, ccJson } from '@/lib/cardcenter';

const BASE_URL = 'https://cardcenter.cc';

interface ListPayment {
  id?: number;
  name: string;
  receivedOn: string;
  amount: number;
  status: string;
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

    // Resolve seller ID — try cached setting first, then reservations
    let sellerId = (await getSetting(uid, 'cc_seller_id'))?.value ?? '';
    if (!sellerId) {
      try {
        const rRes = await fetch(`${BASE_URL}/Api/Reservations`, { headers: { Authorization: `Bearer ${token}` } });
        if (rRes.ok) {
          const rData = await rRes.json() as { items?: { seller: { id: number } }[] } | { seller: { id: number } }[];
          const items = Array.isArray(rData) ? rData : (rData.items ?? []);
          if (items.length > 0) sellerId = String(items[0].seller.id);
        }
      } catch { /* no sellerId */ }
    }
    if (sellerId) {
      await prisma.setting.upsert({
        where: { userId_key: { userId: uid!, key: 'cc_seller_id' } },
        update: { value: sellerId },
        create: { userId: uid!, key: 'cc_seller_id', value: sellerId },
      }).catch(() => { /* non-fatal */ });
    }

    if (!sellerId) return Response.json({ updated: 0, message: 'Could not resolve seller ID' });

    // Fetch all payments across all statuses
    const allPayments: ListPayment[] = [];
    for (const apiStatus of ['Scheduled', 'Sent', 'Completed']) {
      try {
        const params = new URLSearchParams({ status: apiStatus, paidTo: sellerId });
        const res = await fetch(`${BASE_URL}/Api/Payments?${params}`, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) continue;
        const data = await ccJson<{ items?: ListPayment[] }>(res, `Payments?status=${apiStatus}`);
        allPayments.push(...(data.items ?? []));
      } catch { /* skip status */ }
    }

    let totalUpdated = 0;

    // Step 1: For all payments, set overdueAt on orders linked by name (works for Waiting too)
    for (const p of allPayments) {
      if (!p.receivedOn) continue;
      try {
        const result = await prisma.order.updateMany({
          where: { userId: uid, groupReferenceId: p.name, locked: false },
          data: { overdueAt: new Date(p.receivedOn) },
        });
        totalUpdated += result.count;
      } catch { /* skip */ }
    }

    // Step 2: For Sent/Completed payments (have numeric id), match by ccGiftCardId
    // to auto-link unlinked orders and set bgPaidAmount
    for (const p of allPayments.filter(p => p.id)) {
      try {
        const detail = await getPaymentDetail(token, String(p.id));
        const listings = detail.listings ?? [];
        if (listings.length === 0) continue;

        const amountByCardId = new Map<string, number>();
        for (const l of listings) {
          amountByCardId.set(String(l.listing.giftCard.id), l.amount);
        }

        const giftCards = await prisma.giftCard.findMany({
          where: { ccGiftCardId: { in: Array.from(amountByCardId.keys()) }, order: { userId: uid } },
          select: { ccGiftCardId: true, orderId: true },
        });
        if (giftCards.length === 0) continue;

        const overdueAt = p.receivedOn ? new Date(p.receivedOn) : null;
        const amountByOrderId = new Map<number, number>();
        for (const gc of giftCards) {
          if (!gc.ccGiftCardId) continue;
          amountByOrderId.set(gc.orderId, (amountByOrderId.get(gc.orderId) ?? 0) + (amountByCardId.get(gc.ccGiftCardId) ?? 0));
        }

        await Promise.all(
          Array.from(amountByOrderId.entries()).map(([orderId, amount]) =>
            prisma.order.updateMany({
              where: { id: orderId, locked: false },
              data: { bgPaidAmount: amount, groupReferenceId: p.name, ...(overdueAt ? { overdueAt } : {}) },
            })
          )
        );
        totalUpdated += amountByOrderId.size;
      } catch { /* skip */ }
    }

    return Response.json({ updated: totalUpdated });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
