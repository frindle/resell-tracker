import { prisma, getSetting } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { getBgAccessToken } from '@/lib/bgAuth';
import { submitTracking as bgSubmitTracking } from '@/lib/buyinggroup';
import { submitTracking as bsSubmitTracking } from '@/lib/bigsky';
import { submitTracking as bfmrSubmitTracking } from '@/lib/bfmrWeb';
import { NextRequest } from 'next/server';

type ImportRow = {
  platform: string;
  orderNumber: string;
  orderDate: string;
  itemDescription: string;
  cost: number;
  shippingCost: number;
  salePrice: number | null;
  buyerId: string;
  cardId: string;
  cashbackAmount: number;
  sourceUrl?: string;
  shippingAddress?: string;
  trackingNumbers?: string[];
  paymentLast4?: string; // scraped from order's payment-method line — used to auto-assign card when matching exactly one saved card
};

function normalize(n: string | null | undefined): string {
  return (n ?? '').replace(/\D/g, '');
}

function isUselessDescription(desc: string | null | undefined): boolean {
  if (!desc) return true;
  const d = desc.trim().toLowerCase();
  return !d || d === 'walmart.com' || d === 'amazon.com' || d === 'costco.com';
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Extension-User-Id',
    },
  });
}

export async function POST(req: NextRequest) {
  try {
  // Extension passes user id via header; fall back to session
  const headerUserId = req.headers.get('X-Extension-User-Id');
  const userId = headerUserId ? parseInt(headerUserId) : await getSessionUserId();
  const parsed = await req.json();
  const rawRows: ImportRow[] = Array.isArray(parsed) ? parsed.filter((r): r is ImportRow => r !== null && typeof r === 'object') : [];
  console.log(`[import] received ${rawRows.length} rows, first:`, JSON.stringify(rawRows[0]).slice(0, 200));

  // Filter out rows with unparseable dates
  const dateFiltered = rawRows.filter(r => {
    if (!r.orderDate) return false;
    const d = new Date(r.orderDate);
    return !isNaN(d.getTime());
  });

  // Load blocked addresses, shipping rules, and skip list up front
  const [blockedPatterns, shippingRules, skipList] = await Promise.all([
    prisma.blockedAddress.findMany({ select: { pattern: true } }),
    prisma.shippingRule.findMany({ select: { pattern: true, buyerId: true } }),
    prisma.bfmrSkip.findMany({ select: { orderNumber: true } }),
  ]);
  const skipSet = new Set(skipList.map(s => normalize(s.orderNumber)));

  function matchBuyerId(addr: string | undefined): number | null {
    if (!addr) return null;
    const lower = addr.toLowerCase();
    const match = shippingRules.find(r => lower.includes(r.pattern.toLowerCase()));
    return match?.buyerId ?? null;
  }

  function isBlocked(addr: string | undefined): boolean {
    if (!addr || blockedPatterns.length === 0) return false;
    const lower = addr.toLowerCase();
    return blockedPatterns.some(b => lower.includes(b.pattern.toLowerCase()));
  }

  const rows = dateFiltered.filter(r => !isBlocked(r.shippingAddress));
  console.log(`[import] ${rows.length} rows after filters (${rawRows.length - rows.length} dropped)`);

  // Fetch existing orders for this user, keyed by normalized order number
  const allExisting = await prisma.order.findMany({
    where: userId ? { userId } : { userId: null },
    select: {
      id: true,
      orderNumber: true,
      platform: true,
      itemDescription: true,
      sourceUrl: true,
      shippingAddress: true,
      trackingNumbers: true,
      buyerId: true,
      cardId: true,
      salePrice: true,
      cost: true,
      shippingCost: true,
      cashbackAmount: true,
    },
  });
  const existingByNorm = new Map(
    allExisting.filter(o => normalize(o.orderNumber)).map(o => [normalize(o.orderNumber), o])
  );

  const seenInBatch = new Set<string>();
  const toCreate: ImportRow[] = [];
  const toUpdate: { id: number; existing: typeof allExisting[0]; row: ImportRow }[] = [];
  let skipped = 0;

  for (const r of rows) {
    const norm = normalize(r.orderNumber);
    // Orders without a number always create a new record
    if (!norm) {
      toCreate.push(r);
      continue;
    }
    if (seenInBatch.has(norm)) {
      skipped++;
      continue;
    }
    seenInBatch.add(norm);

    const existing = existingByNorm.get(norm);
    if (existing) {
      toUpdate.push({ id: existing.id, existing, row: r });
    } else if (!skipSet.has(norm)) {
      toCreate.push(r);
    } else {
      skipped++;
    }
  }

  // Build a last4 → cardId map so we can auto-assign a card on import when
  // the scraped payment-method line (paymentLast4) matches exactly one of
  // the user's saved cards. Cards without last4 set are ignored. If two
  // cards share the same last 4 digits, neither auto-assigns (ambiguous).
  const userCards = await prisma.creditCard.findMany({
    where: { userId: userId ?? null, last4: { not: null } },
    select: { id: true, last4: true },
  });
  const last4ToCardId = new Map<string, number | null>();
  for (const c of userCards) {
    if (!c.last4) continue;
    if (last4ToCardId.has(c.last4)) last4ToCardId.set(c.last4, null); // duplicate → don't auto-assign
    else last4ToCardId.set(c.last4, c.id);
  }
  function resolveCardId(r: ImportRow): number | null {
    if (r.cardId) return parseInt(r.cardId); // explicit wins
    if (r.paymentLast4) {
      const match = last4ToCardId.get(r.paymentLast4);
      if (match) return match; // null sentinel from dup detection falls through
    }
    return null;
  }

  const [created, updated] = await Promise.all([
    Promise.all(
      toCreate.map(r => {
        const resolvedBuyerId = r.buyerId ? parseInt(r.buyerId) : matchBuyerId(r.shippingAddress);
        return prisma.order.create({
          data: {
            userId: userId ?? null,
            platform: r.platform,
            orderNumber: r.orderNumber || null,
            orderDate: new Date(r.orderDate),
            itemDescription: isUselessDescription(r.itemDescription) ? null : r.itemDescription,
            cost: r.cost,
            shippingCost: r.shippingCost,
            salePrice: r.salePrice ?? null,
            buyerId: resolvedBuyerId,
            cardId: resolveCardId(r),
            cashbackAmount: r.cashbackAmount,
            sourceUrl: r.sourceUrl || null,
            shippingAddress: r.shippingAddress || null,
            trackingNumbers: r.trackingNumbers?.join(',') || null,
            skipAddressBlock: true,
          },
        });
      })
    ),
    Promise.all(
      toUpdate.map(({ id, existing, row: r }) => {
        const incomingTracking = r.trackingNumbers?.join(',') || null;
        const isRealTracking = (t: string | null) => !!(t && /TBA\d{10,}|1Z[A-Z0-9]{16}|9[0-9]{19,21}|55[0-9]{10,}/.test(t));
        // Walmart store deliveries/pickups use the order number as the tracking
        // identifier — treat it as valid tracking so it doesn't get dropped.
        const isOrderNumberTracking = (t: string | null) => {
          if (!t || !existing.orderNumber) return false;
          const tNorm = t.replace(/\D/g, '');
          const oNorm = existing.orderNumber.replace(/\D/g, '');
          return tNorm.length > 0 && tNorm === oNorm;
        };
        const isValidTracking = (t: string | null) => isRealTracking(t) || isOrderNumberTracking(t);
        // Detect "fake" Walmart tracking — when the stored value is just the
        // order number (digits, no dashes). This was set by an old extension
        // bug (v1.1.43) that always fell back to the order number whenever
        // detail fetching returned no carrier tracking. The v1.1.44 extension
        // only falls back when an internal 555-ID was actually filtered, so
        // we want to let new imports clear the bad data here.
        const existingIsOrderNumberFake = (() => {
          if (!existing.trackingNumbers || !existing.orderNumber) return false;
          const ordNoDashes = existing.orderNumber.replace(/-/g, '');
          return existing.trackingNumbers === ordNoDashes || existing.trackingNumbers === existing.orderNumber;
        })();
        // Real tracking always wins; never clear existing real tracking with
        // nothing. Existing "fake" (order-number) tracking is treated as
        // missing so the new import value can overwrite it (including clearing
        // to null when no carrier or 555-fallback is present this time).
        const resolvedTracking = isValidTracking(incomingTracking)
          ? incomingTracking
          : !existingIsOrderNumberFake && isValidTracking(existing.trackingNumbers)
            ? undefined
            : (incomingTracking || (existingIsOrderNumberFake ? null : undefined));
        const resolvedBuyerId = existing.buyerId
          ?? (r.buyerId ? parseInt(r.buyerId) : matchBuyerId(r.shippingAddress ?? existing.shippingAddress ?? undefined));
        return prisma.order.update({
          where: { id },
          data: {
            // Upgrade platform from 'Other' (BFMR imports) to the real retailer when scraped
            ...(existing.platform === 'Other' && r.platform !== 'Other' ? { platform: r.platform } : {}),
            itemDescription: isUselessDescription(existing.itemDescription) ? (isUselessDescription(r.itemDescription) ? null : r.itemDescription) : existing.itemDescription,
            sourceUrl: existing.sourceUrl ?? (r.sourceUrl || null),
            shippingAddress: existing.shippingAddress || (r.shippingAddress || null),
            trackingNumbers: resolvedTracking,
            salePrice: existing.salePrice ?? r.salePrice,
            buyerId: resolvedBuyerId,
            cardId: existing.cardId ?? resolveCardId(r),
            cost: (existing.cost !== 0 && existing.cost != null) ? existing.cost : r.cost,
            shippingCost: (existing.shippingCost !== 0 && existing.shippingCost != null) ? existing.shippingCost : r.shippingCost,
            cashbackAmount: existing.cashbackAmount !== 0 ? existing.cashbackAmount : r.cashbackAmount,
            skipAddressBlock: true,
          },
        });
      })
    ),
  ]);

  // Auto-submit newly-arrived tracking numbers to buying groups (fire and forget)
  void (async () => {
    try {
      const candidateIds = [
        ...created.filter(o => o.trackingNumbers).map(o => o.id),
        ...updated.filter(o => o.trackingNumbers && !o.trackingSubmittedToBg).map(o => o.id),
      ];
      if (candidateIds.length === 0) return;

      const ordersWithBuyers = await prisma.order.findMany({
        where: { id: { in: candidateIds }, trackingSubmittedToBg: false, trackingNumbers: { not: null } },
        include: { buyer: true },
      });

      const bgTrackings: string[] = [];
      const bsTrackings: string[] = [];
      const bgOrderIds: number[] = [];
      const bsOrderIds: number[] = [];

      for (const order of ordersWithBuyers) {
        if (!order.trackingNumbers) continue;
        const trackings = order.trackingNumbers.split(',').map(t => t.trim()).filter(Boolean);
        const buyerName = order.buyer?.name?.toLowerCase() ?? '';
        if (buyerName.includes('buyinggroup') || buyerName.includes('buying group')) {
          bgTrackings.push(...trackings);
          bgOrderIds.push(order.id);
        } else if (buyerName.includes('bigsky') || buyerName.includes('big sky')) {
          bsTrackings.push(...trackings);
          bsOrderIds.push(order.id);
        }
      }

      const submittedIds: number[] = [];

      if (bgTrackings.length > 0) {
        try {
          const token = await getBgAccessToken(userId ?? null);
          await bgSubmitTracking(token, bgTrackings);
          submittedIds.push(...bgOrderIds);
        } catch { /* credentials not configured or API error */ }
      }

      if (bsTrackings.length > 0) {
        try {
          const cookieSetting = await getSetting(userId ?? null, 'bigsky_cookie');
          if (cookieSetting?.value) {
            await bsSubmitTracking(cookieSetting.value, bsTrackings);
            submittedIds.push(...bsOrderIds);
          }
        } catch { /* credentials not configured or API error */ }
      }

      if (submittedIds.length > 0) {
        await prisma.order.updateMany({
          where: { id: { in: submittedIds } },
          data: { trackingSubmittedToBg: true },
        });
      }

      // BFMR auto-submit DISABLED June 2026.
      //
      // BFMR exposes one row per shipment for split orders, each row showing
      // its own item/qty breakdown. Auto-matching our captured tracking
      // numbers to those rows by order_id alone risks assigning the wrong
      // tracking to a row when shipments split. Until we have a verified
      // match (item-count, carrier, or user-confirmed), don't push.
      //
      // Submission still works from the manual /api/bfmr/push-tracking and
      // /api/orders/submit-tracking endpoints — those will be re-pointed at
      // a new BFMR submission review UI (see TODO).
    } catch { /* don't let tracking submission failure affect import */ }
  })();

  return new Response(JSON.stringify({ imported: created.length, updated: updated.length, skipped }), {
    status: 201,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
  } catch (e) {
    console.error('[import] error:', e);
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}
