import { prisma, getSetting } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { getMyTracker } from '@/lib/bfmr';
import { NextRequest } from 'next/server';

function normalize(n: string | null | undefined): string {
  return (n ?? '').replace(/\D/g, '');
}

export async function POST(req: NextRequest) {
  const userId = await getSessionUserId();
  const uid = userId ?? null;

  const [k, s] = await Promise.all([
    getSetting(uid, 'bfmr_api_key'),
    getSetting(uid, 'bfmr_api_secret'),
  ]);
  if (!k?.value || !s?.value) return new Response('BFMR not configured', { status: 400 });
  const creds = { apiKey: k.value, apiSecret: s.value };

  const body = await req.json() as { startDate?: string; buyerId?: number };

  // Fetch all tracker items (up to 500)
  const filters: Record<string, string> = { page_size: '500' };
  if (body.startDate) filters.start_date = body.startDate;

  let items;
  try {
    items = await getMyTracker(creds, filters);
  } catch (e) {
    return new Response(String(e), { status: 502 });
  }

  // Only items with an order number
  const withOrderNo = items.filter(i => i.order_no);

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
    const norm = normalize(item.order_no);
    const order = existingByNorm.get(norm);

    if (!order) {
      unmatched++;
      continue;
    }

    // Sale price: prefer amount_paid (actual payout), fall back to sub_total (expected)
    const bfmrSalePrice = item.amount_paid || item.sub_total || null;

    const patch: Record<string, unknown> = {};

    if (order.salePrice == null && bfmrSalePrice != null) {
      patch.salePrice = bfmrSalePrice;
    }
    if (order.buyerId == null && body.buyerId) {
      patch.buyerId = body.buyerId;
    }

    if (Object.keys(patch).length > 0) {
      await prisma.order.update({ where: { id: order.id }, data: patch });
      updated++;
    }
  }

  return Response.json({ updated, unmatched, total: withOrderNo.length });
}
