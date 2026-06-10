import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
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
