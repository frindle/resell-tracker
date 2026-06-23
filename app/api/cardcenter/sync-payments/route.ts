import { prisma, getSetting } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { getCcToken, ccJson, CcPayment } from '@/lib/cardcenter';

const BASE_URL = 'https://cardcenter.cc';

const STATUS_SEGMENT: Record<string, string> = {
  Waiting: 'Scheduled',
  Sent: 'Sent',
  Completed: 'Completed',
};

interface ListPayment {
  id?: number;
  name: string;
  receivedOn: string;
  amount: number;
  status: string;
  paidBy: { id: number };
}

function paymentDetailUrl(p: ListPayment, sellerId: string): string {
  // Use /Api/Payments/{status}/{buyerId}/{sellerId}/{date} for all payments
  const nameMatch = p.name.match(/^P\d+-(\d{4})(\d{2})(\d{2})$/);
  if (nameMatch) {
    const [, year, month, day] = nameMatch;
    const segment = STATUS_SEGMENT[p.status] ?? 'Scheduled';
    return `${BASE_URL}/Api/Payments/${segment}/${p.paidBy.id}/${sellerId}/${year}-${month}-${day}`;
  }
  return `${BASE_URL}/Api/Payments/${encodeURIComponent(p.name)}`;
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
    if (sellerId && uid !== null) {
      await prisma.setting.upsert({
        where: { userId_key: { userId: uid, key: 'cc_seller_id' } },
        update: { value: sellerId },
        create: { userId: uid, key: 'cc_seller_id', value: sellerId },
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

    // For each payment: fetch detail (works for all statuses), match by listing.id → ccGiftCardId
    for (const p of allPayments) {
      try {
        const url = paymentDetailUrl(p, sellerId);
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) continue;
        const detail = await ccJson<CcPayment>(res, `Payments detail ${p.name}`);
        const listings = detail.listings ?? [];
        if (listings.length === 0) continue;

        const overdueAt = p.receivedOn ? new Date(p.receivedOn) : null;

        // Match by listing.id (= ccGiftCardId) first, then by code suffix as
        // a fallback. Older submissions never persisted ccGiftCardId; we can
        // still back-fill them by suffix-matching listing.giftCard.code to
        // GiftCard.cardNumber.
        const amountByListingId = new Map<string, number>();
        const codeAndAmountByListingId = new Map<string, { code: string | undefined; amount: number }>();
        for (const l of listings) {
          amountByListingId.set(String(l.listing.id), l.amount);
          codeAndAmountByListingId.set(String(l.listing.id), { code: l.listing.giftCard?.code, amount: l.amount });
        }

        // Primary path: any of our cards whose ccGiftCardId matches a listing.
        let giftCards = await prisma.giftCard.findMany({
          where: { ccGiftCardId: { in: Array.from(amountByListingId.keys()) }, order: { userId: uid } },
          select: { id: true, ccGiftCardId: true, ccPurchasePrice: true, orderId: true, cardNumber: true },
        });

        // Fallback path: this payment has listings whose ccGiftCardId we
        // never persisted on our side. Match by card-code suffix among
        // gift cards we haven't tied to a listing yet — also include cards
        // whose ccSubmittedAt is still null (users who uploaded via CC's
        // website directly never went through our submit flow). Verbose
        // logging so we can diagnose misses without code changes.
        const matchedListingIds = new Set(giftCards.map(gc => gc.ccGiftCardId));
        const unmatchedListings = [...codeAndAmountByListingId.entries()].filter(([id]) => !matchedListingIds.has(id));
        console.log(`[cc/sync-payments] payment ${p.name}: ${listings.length} listings, ${giftCards.length} matched by ccGiftCardId, ${unmatchedListings.length} unmatched`);
        if (unmatchedListings.length > 0) {
          const orphans = await prisma.giftCard.findMany({
            where: {
              ccGiftCardId: null,
              order: { userId: uid },
            },
            select: { id: true, ccGiftCardId: true, ccPurchasePrice: true, orderId: true, cardNumber: true },
          });
          console.log(`[cc/sync-payments] ${orphans.length} orphan gift cards available for code-suffix match`);
          for (const [listingId, { code, amount }] of unmatchedListings) {
            if (!code) { console.log(`[cc/sync-payments] listing ${listingId}: no code in detail, can't match`); continue; }
            const codeStripped = code.replace(/^…/, '');
            const match = orphans.find(o => o.cardNumber.endsWith(codeStripped));
            if (match) {
              await prisma.giftCard.update({
                where: { id: match.id },
                data: { ccGiftCardId: listingId, ccPurchasePrice: amount },
              });
              giftCards.push({ ...match, ccGiftCardId: listingId, ccPurchasePrice: amount });
              console.log(`[cc/sync-payments] back-fill orphan giftCard ${match.id} → listing ${listingId}, paid $${amount}`);
            } else {
              console.log(`[cc/sync-payments] listing ${listingId} code "${code}" (suffix "${codeStripped}") — no orphan cardNumber matches`);
            }
          }
        }

        if (giftCards.length === 0) continue;

        // Back-fill the per-card payout (ccPurchasePrice) on any matched
        // GiftCard that doesn't have it yet.
        for (const gc of giftCards) {
          if (gc.ccPurchasePrice == null && gc.ccGiftCardId) {
            const amt = amountByListingId.get(gc.ccGiftCardId);
            if (amt != null) {
              await prisma.giftCard.update({ where: { id: gc.id }, data: { ccPurchasePrice: amt } });
            }
          }
        }

        const amountByOrderId = new Map<number, number>();
        for (const gc of giftCards) {
          if (!gc.ccGiftCardId) continue;
          amountByOrderId.set(gc.orderId, (amountByOrderId.get(gc.orderId) ?? 0) + (amountByListingId.get(gc.ccGiftCardId) ?? 0));
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
