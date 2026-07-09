import { prisma, getSetting } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { getCcToken, ccJson, CcPayment } from '@/lib/cardcenter';
import { NextRequest } from 'next/server';

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

export async function POST(req: NextRequest) {
  try {
    const sessionUid = await getSessionUserId();
    const headerUid = req.headers.get('X-Extension-User-Id');
    const userId = sessionUid ?? (headerUid ? parseInt(headerUid) : null);
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
    // Track every order touched across all payment iterations so we can
    // do one rollup pass at the end. Per-payment bgPaidAmount writes
    // would otherwise overwrite each other when an order spans multiple
    // payments. Rolling up after fixes that and lets us also set
    // order.salePrice to the sum of all per-card paid values.
    const touchedOrderIds = new Set<number>();

    // For each payment: fetch detail (works for all statuses), match by listing.id → ccGiftCardId
    for (const p of allPayments) {
      try {
        const url = paymentDetailUrl(p, sellerId);
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) continue;
        const detail = await ccJson<CcPayment>(res, `Payments detail ${p.name}`);
        const listings = detail.listings ?? [];
        if (listings.length === 0) continue;

        // Waiting = scheduled but not yet posted. Its receivedOn is the
        // FUTURE expected date; if we wrote it as overdueAt, the badge
        // shows "Overdue since <future date>" and the card's amount gets
        // counted as paid — both wrong. Only stamp overdueAt when the
        // payment is actually posted (Sent / Completed).
        const isPosted = p.status !== 'Waiting';
        // CC's receivedOn is bare "YYYY-MM-DD"; anchor noon UTC so it
        // doesn't render as previous day in US timezones.
        const overdueAt = isPosted && p.receivedOn ? new Date(`${p.receivedOn}T12:00:00Z`) : null;

        // Two IDs per listing — both meaningful:
        //   listing.id            — the listing ID (e.g. 9045043). Payment is tied to a listing.
        //                            A card can be re-listed, so it can have multiple listings
        //                            over time, each with its own payment.
        //   listing.giftCard.id   — the gift card ID (e.g. 8232432). Card identity, stable.
        // Match preference: ccListingId (most precise) → ccGiftCardId (card-level
        // fallback, useful for cards submitted before we started persisting listing
        // IDs) → code-suffix → merchant+value.
        const amountByListingId = new Map<string, number>();
        const amountByGiftCardId = new Map<string, number>();
        type ListingInfo = { code: string | undefined; amount: number; brandName: string; value: number; listingId: string; giftCardId: string };
        const infoByListingId = new Map<string, ListingInfo>();
        for (const l of listings) {
          const giftCardId = String(l.listing.giftCard?.id ?? '');
          const listingId = String(l.listing.id);
          if (!listingId) continue;
          amountByListingId.set(listingId, l.amount);
          if (giftCardId) amountByGiftCardId.set(giftCardId, l.amount);
          infoByListingId.set(listingId, {
            code: l.listing.giftCard?.code,
            amount: l.amount,
            brandName: l.listing.brand?.name ?? '',
            value: l.listing.value,
            listingId,
            giftCardId,
          });
        }

        // Primary path: ccListingId (precise — match the exact sale event).
        const byListing = await prisma.giftCard.findMany({
          where: { ccListingId: { in: Array.from(amountByListingId.keys()) }, order: { userId: uid } },
          select: { id: true, ccGiftCardId: true, ccListingId: true, ccPurchasePrice: true, orderId: true, cardNumber: true, merchant: true, value: true },
        });
        const matchedListingIds = new Set(byListing.map(gc => gc.ccListingId));

        // Secondary path: ccGiftCardId — covers cards submitted before
        // ccListingId was being persisted, and one-card-one-listing cases.
        // Filter out giftCardIds whose listing already matched via the
        // precise path.
        const giftCardIdsForFallback = [...amountByGiftCardId.keys()].filter(gid => {
          const info = [...infoByListingId.values()].find(v => v.giftCardId === gid);
          return info && !matchedListingIds.has(info.listingId);
        });
        const byCard = await prisma.giftCard.findMany({
          where: { ccGiftCardId: { in: giftCardIdsForFallback }, order: { userId: uid } },
          select: { id: true, ccGiftCardId: true, ccListingId: true, ccPurchasePrice: true, orderId: true, cardNumber: true, merchant: true, value: true },
        });

        // Repair pass: cards submitted before the ccGiftCardId → ccListingId
        // transition (#23) sometimes stored the LISTING id inside the
        // ccGiftCardId column. Detect that by seeing whether a card's
        // ccGiftCardId actually matches an incoming listing.id (not a
        // gift-card id). When found: move the value to ccListingId and
        // populate ccGiftCardId from the listing's gift card.
        const listingIdsHere = new Set(Array.from(amountByListingId.keys()));
        const byListingIdInWrongCol = await prisma.giftCard.findMany({
          where: { ccGiftCardId: { in: Array.from(listingIdsHere) }, order: { userId: uid } },
          select: { id: true, ccGiftCardId: true, ccListingId: true, ccPurchasePrice: true, orderId: true, cardNumber: true, merchant: true, value: true },
        });
        for (const gc of byListingIdInWrongCol) {
          const listingId = gc.ccGiftCardId ?? '';
          const info = infoByListingId.get(listingId);
          if (!info) continue;
          const correctGiftCardId = info.giftCardId || null;
          console.log(`[cc/sync-payments] repairing giftCard ${gc.id}: ccGiftCardId "${listingId}" was a listing id → moving to ccListingId, setting ccGiftCardId=${correctGiftCardId}`);
          await prisma.giftCard.update({
            where: { id: gc.id },
            data: {
              ccListingId: listingId,
              ccGiftCardId: correctGiftCardId,
            },
          });
          // Fold into the merged list so downstream logic treats it as matched
          gc.ccListingId = listingId;
          gc.ccGiftCardId = correctGiftCardId;
        }

        let giftCards = [
          ...byListing,
          ...byCard.filter(c => !byListing.some(b => b.id === c.id)),
          ...byListingIdInWrongCol.filter(c =>
            !byListing.some(b => b.id === c.id) &&
            !byCard.some(b => b.id === c.id)
          ),
        ];

        const matchedListingIdSet = new Set<string>(matchedListingIds as Set<string>);
        for (const gc of byCard) {
          const info = [...infoByListingId.values()].find(v => v.giftCardId === gc.ccGiftCardId);
          if (info) matchedListingIdSet.add(info.listingId);
        }
        for (const gc of byListingIdInWrongCol) {
          if (gc.ccListingId) matchedListingIdSet.add(gc.ccListingId);
        }
        const unmatchedListings = [...infoByListingId.entries()].filter(([lid]) => !matchedListingIdSet.has(lid));
        console.log(`[cc/sync-payments] payment ${p.name}: ${listings.length} listings, ${giftCards.length} matched by ccGiftCardId, ${unmatchedListings.length} unmatched`);
        if (unmatchedListings.length > 0) {
          const orphans = await prisma.giftCard.findMany({
            where: { ccGiftCardId: null, order: { userId: uid } },
            select: { id: true, ccGiftCardId: true, ccPurchasePrice: true, orderId: true, cardNumber: true, merchant: true, value: true },
          });
          // Track which orphan IDs we've consumed across the loop so a
          // second listing of the same brand+value doesn't double-match.
          const consumed = new Set<number>();
          console.log(`[cc/sync-payments] uid=${uid}: ${orphans.length} orphan gift cards available for fallback match`);
          // Deep diagnostic for the "I see the card in the UI but no orphan"
          // case — list every GiftCard scoped to this user with its
          // ccGiftCardId value so we can tell whether the issue is scope
          // (orders under a different userId) or stale ccGiftCardId values.
          if (orphans.length === 0) {
            const allUserCards = await prisma.giftCard.findMany({
              where: { order: { userId: uid } },
              select: { id: true, merchant: true, value: true, ccGiftCardId: true, ccSubmittedAt: true, orderId: true },
            });
            console.log(`[cc/sync-payments] uid=${uid}: total GiftCard records for this user = ${allUserCards.length}`);
            for (const c of allUserCards.slice(0, 20)) {
              console.log(`[cc/sync-payments]   gc${c.id} order=${c.orderId} ${c.merchant} $${c.value} ccGiftCardId=${c.ccGiftCardId ?? 'null'} submittedAt=${c.ccSubmittedAt ? 'yes' : 'no'}`);
            }
          }
          for (const [lid, { code, amount, brandName, value, listingId, giftCardId }] of unmatchedListings) {
            const codeStripped = code ? code.replace(/^…/, '') : '';
            const available = orphans.filter(o => !consumed.has(o.id));

            // Tier 1: code-suffix match against stored cardNumber.
            let match = codeStripped ? available.find(o => o.cardNumber && o.cardNumber.endsWith(codeStripped)) : undefined;
            let how = 'code';

            // Tier 2: merchant + face value uniqueness. Safe when there's
            // exactly one available orphan with the same merchant + value.
            if (!match) {
              const byMerchantValue = available.filter(o =>
                o.merchant.toLowerCase() === brandName.toLowerCase() && Math.abs(o.value - value) < 0.01
              );
              if (byMerchantValue.length === 1) {
                match = byMerchantValue[0];
                how = 'merchant+value';
              } else if (byMerchantValue.length > 1) {
                console.log(`[cc/sync-payments] listing ${listingId} (${brandName} $${value}) — ${byMerchantValue.length} orphans match merchant+value, ambiguous, skipping`);
              }
            }

            if (match) {
              await prisma.giftCard.update({
                where: { id: match.id },
                data: { ccGiftCardId: giftCardId || null, ccListingId: listingId, ccPurchasePrice: amount },
              });
              consumed.add(match.id);
              giftCards.push({ ...match, ccGiftCardId: giftCardId || null, ccListingId: listingId, ccPurchasePrice: amount });
              console.log(`[cc/sync-payments] back-fill orphan giftCard ${match.id} → listing ${listingId} / card ${giftCardId} via ${how}, paid $${amount}`);
              // Avoid double-counting in lid loop
              void lid;
            } else {
              console.log(`[cc/sync-payments] listing ${listingId} (card ${giftCardId}, ${brandName} $${value}, code "${code ?? '-'}") — no orphan matches`);
            }
          }
        }

        if (giftCards.length === 0) continue;

        // For each matched card, resolve which payment-listing belongs to
        // it: prefer ccListingId (precise), fall back to ccGiftCardId.
        // Then back-fill ccPurchasePrice and ccListingId where missing.
        function amountFor(gc: { ccListingId?: string | null; ccGiftCardId?: string | null }): { amount: number | undefined; listingId: string | undefined } {
          if (gc.ccListingId) {
            const amt = amountByListingId.get(gc.ccListingId);
            if (amt != null) return { amount: amt, listingId: gc.ccListingId };
          }
          if (gc.ccGiftCardId) {
            const info = [...infoByListingId.values()].find(v => v.giftCardId === gc.ccGiftCardId);
            if (info) return { amount: info.amount, listingId: info.listingId };
          }
          return { amount: undefined, listingId: undefined };
        }

        for (const gc of giftCards) {
          const { amount, listingId } = amountFor(gc);
          if (amount == null) continue;
          const patch: Record<string, unknown> = {};
          if (gc.ccPurchasePrice == null) {
            patch.ccPurchasePrice = amount;
          } else if (Math.abs(gc.ccPurchasePrice - amount) > 0.005) {
            // CC adjusted the paid value after we first stored it
            // (e.g. they re-priced the offer or applied a correction).
            // Log the delta + update so the per-card "Paid" column
            // reflects the new amount.
            console.log(`[cc/payment-delta] giftCard ${gc.id} (listing ${listingId ?? '?'}): $${gc.ccPurchasePrice} → $${amount}`);
            patch.ccPurchasePrice = amount;
          }
          if (!gc.ccListingId && listingId) patch.ccListingId = listingId;
          // Track payment lifecycle state per card. Rollup below only
          // counts Sent/Completed toward bgPaidAmount; Waiting is
          // scheduled (not yet paid) and must not inflate the total.
          patch.ccPaymentStatus = p.status;
          patch.ccPaymentName = p.name;
          if (Object.keys(patch).length) {
            await prisma.giftCard.update({ where: { id: gc.id }, data: patch });
          }
        }

        const amountByOrderId = new Map<number, number>();
        for (const gc of giftCards) {
          const { amount } = amountFor(gc);
          if (amount == null) continue;
          amountByOrderId.set(gc.orderId, (amountByOrderId.get(gc.orderId) ?? 0) + amount);
        }

        await Promise.all(
          Array.from(amountByOrderId.entries()).map(([orderId]) => {
            touchedOrderIds.add(orderId);
            return prisma.order.updateMany({
              // Once paid (salePriceSynced=true), never re-stamp overdueAt —
              // otherwise the cleared badge re-appears on the next sync.
              where: { id: orderId, locked: false, salePriceSynced: false },
              data: { groupReferenceId: p.name, ...(overdueAt ? { overdueAt } : {}) },
            });
          })
        );
        totalUpdated += amountByOrderId.size;
      } catch (e) {
        // Don't fail the whole sync if one payment is malformed, but log it
        // so we can spot patterns instead of silently dropping data.
        console.warn(`[cc/sync-payments] payment ${p.name} threw:`, e);
      }
    }

    // Rollup pass: for every order touched, compute two sums per order:
    //   - salePrice = sum of ALL ccPurchasePrice (expected total,
    //     including scheduled payments that haven't posted yet).
    //   - bgPaidAmount = sum of ccPurchasePrice ONLY for cards whose
    //     payment status is Sent or Completed. Waiting = scheduled but
    //     not paid; counting those toward bgPaidAmount produces the
    //     "Partial $40 of $80" false positive from the P1056-20260709
    //     case.
    // Skips locked orders. One groupBy per bucket keeps this O(2) round
    // trips instead of O(N).
    const [sumsAll, sumsPaid] = await Promise.all([
      prisma.giftCard.groupBy({
        by: ['orderId'],
        where: { orderId: { in: [...touchedOrderIds] } },
        _sum: { ccPurchasePrice: true },
        _count: { _all: true },
      }),
      prisma.giftCard.groupBy({
        by: ['orderId'],
        where: {
          orderId: { in: [...touchedOrderIds] },
          ccPaymentStatus: { in: ['Sent', 'Completed'] },
        },
        _sum: { ccPurchasePrice: true },
        _count: { _all: true },
      }),
    ]);
    const paidByOrderId = new Map<number, { sum: number; count: number }>();
    for (const row of sumsPaid) paidByOrderId.set(row.orderId, { sum: row._sum.ccPurchasePrice ?? 0, count: row._count._all });
    await Promise.all(sumsAll.map(async row => {
      const totalExpected = row._sum.ccPurchasePrice ?? 0;
      const paid = paidByOrderId.get(row.orderId) ?? { sum: 0, count: 0 };
      const roundedExpected = Math.round(totalExpected * 100) / 100;
      const roundedPaid = Math.round(paid.sum * 100) / 100;
      if (roundedExpected <= 0 && roundedPaid <= 0) return;
      // Fully paid = every card on the order has a posted (Sent/Completed)
      // payment and the paid sum covers the expected total. This is what
      // actually flips the order badge to "Paid" — without salePriceSynced
      // the order sits on Pending/Overdue forever even though bgPaidAmount
      // is complete (the exact bug with P1056-20260703/-20260706).
      const fullyPaid = paid.count === row._count._all &&
        paid.count > 0 &&
        roundedPaid >= roundedExpected - 0.01;
      const { count } = await prisma.order.updateMany({
        where: { id: row.orderId, locked: false },
        data: {
          ...(roundedExpected > 0 ? { salePrice: roundedExpected } : {}),
          bgPaidAmount: roundedPaid,
          ...(fullyPaid ? { salePriceSynced: true, overdueAt: null } : {}),
        },
      });
      console.log(`[cc/sync-payments] rollup order ${row.orderId}: salePrice=$${roundedExpected} bgPaidAmount=$${roundedPaid} fullyPaid=${fullyPaid} (count=${count})`);
    }));

    return Response.json({ updated: totalUpdated, touched: touchedOrderIds.size });
  } catch (e) {
    const { logApiError } = await import('@/lib/apiErrorLog');
    const { getSessionUserId } = await import('@/lib/auth');
    const uid = await getSessionUserId().catch(() => null);
    void logApiError({
      userId: uid ?? null, group: 'CC', endpoint: '/api/cardcenter/sync-payments',
      method: 'POST', status: 500, body: String(e).slice(0, 1500),
      context: 'sync-payments threw',
    });
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
