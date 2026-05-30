import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import type { TrackerItem } from '@/lib/bfmr';
import { NextRequest } from 'next/server';

function normalize(n: string | null | undefined): string {
  return (n ?? '').replace(/\D/g, '');
}

export async function POST(req: NextRequest) {
  const userId = await getSessionUserId();
  const uid = userId ?? null;

  const body = await req.json() as { items: TrackerItem[] };
  const items: TrackerItem[] = Array.isArray(body.items) ? body.items : [];

  // Only items with an order number
  const withOrderNo = items.filter(i => i.order_id);

  // Fetch existing orders for this user
  const existing = await prisma.order.findMany({
    where: uid ? { userId: uid } : { userId: null },
    select: { id: true, orderNumber: true, salePrice: true, buyerId: true },
  });
  const existingByNorm = new Map(
    existing.filter(o => normalize(o.orderNumber)).map(o => [normalize(o.orderNumber!), o])
  );

  let updated = 0;
  let unmatched = 0;

  for (const item of withOrderNo) {
    const norm = normalize(item.order_id as string);
    const order = existingByNorm.get(norm);

    if (!order) {
      unmatched++;
      continue;
    }

    // Sale price: prefer amount_paid (actual payout), fall back to sub_total (expected)
    const bfmrSalePrice = parseFloat(String(item.amount_paid || item.sub_total || '')) || null;

    const patch: Record<string, unknown> = {};

    if (order.salePrice == null && bfmrSalePrice != null) {
      patch.salePrice = bfmrSalePrice;
    }
    if (Object.keys(patch).length > 0) {
      await prisma.order.update({ where: { id: order.id }, data: patch });
      updated++;
    }
  }

  return Response.json({ updated, unmatched, total: items.length, withOrderNo: withOrderNo.length });
}
