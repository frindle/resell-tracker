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
};

function normalize(n: string | null | undefined): string {
  return (n ?? '').replace(/\D/g, '');
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
            itemDescription: r.itemDescription || null,
            cost: r.cost,
            shippingCost: r.shippingCost,
            salePrice: r.salePrice ?? null,
            buyerId: resolvedBuyerId,
            cardId: r.cardId ? parseInt(r.cardId) : null,
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
        const isRealTracking = (t: string | null) => !!(t && /TBA\d{10,}|1Z[A-Z0-9]{16}|9[0-9]{19,21}/.test(t));
        // Real tracking always wins; never clear existing real tracking with nothing
        const resolvedTracking = isRealTracking(incomingTracking)
          ? incomingTracking
          : isRealTracking(existing.trackingNumbers)
            ? undefined
            : (incomingTracking || undefined);
        const resolvedBuyerId = existing.buyerId
          ?? (r.buyerId ? parseInt(r.buyerId) : matchBuyerId(r.shippingAddress ?? existing.shippingAddress ?? undefined));
        return prisma.order.update({
          where: { id },
          data: {
            // Upgrade platform from 'Other' (BFMR imports) to the real retailer when scraped
            ...(existing.platform === 'Other' && r.platform !== 'Other' ? { platform: r.platform } : {}),
            itemDescription: existing.itemDescription || (r.itemDescription || null),
            sourceUrl: existing.sourceUrl ?? (r.sourceUrl || null),
            shippingAddress: existing.shippingAddress || (r.shippingAddress || null),
            trackingNumbers: resolvedTracking,
            salePrice: existing.salePrice ?? r.salePrice,
            buyerId: resolvedBuyerId,
            cardId: existing.cardId ?? (r.cardId ? parseInt(r.cardId) : null),
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
