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
  const rawRows: ImportRow[] = await req.json();

  // Filter out rows with unparseable dates
  const rows = rawRows.filter(r => {
    if (!r.orderDate) return false;
    const d = new Date(r.orderDate);
    return !isNaN(d.getTime());
  });

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
    } else {
      toCreate.push(r);
    }
  }

  const [created, updated] = await Promise.all([
    Promise.all(
      toCreate.map(r =>
        prisma.order.create({
          data: {
            userId: userId ?? null,
            platform: r.platform,
            orderNumber: r.orderNumber || null,
            orderDate: new Date(r.orderDate),
            itemDescription: r.itemDescription || null,
            cost: r.cost,
            shippingCost: r.shippingCost,
            salePrice: r.salePrice || null,
            buyerId: r.buyerId ? parseInt(r.buyerId) : null,
            cardId: r.cardId ? parseInt(r.cardId) : null,
            cashbackAmount: r.cashbackAmount,
            sourceUrl: r.sourceUrl || null,
            shippingAddress: r.shippingAddress || null,
            trackingNumbers: r.trackingNumbers?.join(',') || null,
          },
        })
      )
    ),
    Promise.all(
      toUpdate.map(({ id, existing, row: r }) => {
        const incomingTracking = r.trackingNumbers?.join(',') || null;
        return prisma.order.update({
          where: { id },
          data: {
            itemDescription: existing.itemDescription ?? (r.itemDescription || null),
            sourceUrl: existing.sourceUrl ?? (r.sourceUrl || null),
            shippingAddress: existing.shippingAddress ?? (r.shippingAddress || null),
            // Always update tracking if incoming has data and existing is empty
            trackingNumbers: existing.trackingNumbers ? undefined : incomingTracking,
            salePrice: existing.salePrice ?? r.salePrice,
            buyerId: existing.buyerId ?? (r.buyerId ? parseInt(r.buyerId) : null),
            cardId: existing.cardId ?? (r.cardId ? parseInt(r.cardId) : null),
            cost: existing.cost || r.cost,
            shippingCost: existing.shippingCost || r.shippingCost,
            cashbackAmount: existing.cashbackAmount || r.cashbackAmount,
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
