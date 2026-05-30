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
  // Extension passes user id via header; fall back to session
  const headerUserId = req.headers.get('X-Extension-User-Id');
  const userId = headerUserId ? parseInt(headerUserId) : await getSessionUserId();
  const rows: ImportRow[] = await req.json();

  // Fetch existing orders for this user, keyed by normalized order number
  const allExisting = await prisma.order.findMany({
    where: userId ? { userId } : { userId: null },
    select: {
      id: true,
      orderNumber: true,
      itemDescription: true,
      sourceUrl: true,
      shippingAddress: true,
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
          },
        })
      )
    ),
    Promise.all(
      toUpdate.map(({ id, existing, row: r }) =>
        prisma.order.update({
          where: { id },
          data: {
            // Only fill in fields that are currently missing
            itemDescription: existing.itemDescription ?? (r.itemDescription || null),
            sourceUrl: existing.sourceUrl ?? (r.sourceUrl || null),
            shippingAddress: existing.shippingAddress ?? (r.shippingAddress || null),
            salePrice: existing.salePrice ?? r.salePrice,
            buyerId: existing.buyerId ?? (r.buyerId ? parseInt(r.buyerId) : null),
            cardId: existing.cardId ?? (r.cardId ? parseInt(r.cardId) : null),
            // Update cost/shipping/cashback only if currently zero
            cost: existing.cost || r.cost,
            shippingCost: existing.shippingCost || r.shippingCost,
            cashbackAmount: existing.cashbackAmount || r.cashbackAmount,
          },
        })
      )
    ),
  ]);

  return new Response(JSON.stringify({ imported: created.length, updated: updated.length, skipped }), {
    status: 201,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
