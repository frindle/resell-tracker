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

  const body = await req.json() as { startDate?: string };

  // Fetch all tracker items (up to 500)
  const today = new Date().toISOString().slice(0, 10);
  const filters: Record<string, string> = { page_size: '200', end_date: today, quick_filter: 'all' };
  if (body.startDate) filters.start_date = body.startDate;

  let items;
  let rawKeys: string[] = [];
  try {
    const params = new URLSearchParams(filters);
    const raw = await fetch(`https://api.bfmr.com/api/v2/my-tracker?${params}`, {
      signal: AbortSignal.timeout(30_000),
      headers: { 'API-KEY': creds.apiKey, 'API-SECRET': creds.apiSecret, 'Content-Type': 'application/json' },
    });
    const rawData = await raw.json();
    rawKeys = Object.keys(rawData);
    items = rawData.my_tracker ?? rawData.tracker ?? rawData.data ?? rawData.items ?? rawData.results ?? [];
    if (!Array.isArray(items)) items = [];
  } catch (e) {
    return new Response(String(e), { status: 502 });
  }

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
    const bfmrSalePrice = item.amount_paid || item.sub_total || null;

    const patch: Record<string, unknown> = {};

    if (order.salePrice == null && bfmrSalePrice != null) {
      patch.salePrice = bfmrSalePrice;
    }
if (Object.keys(patch).length > 0) {
      await prisma.order.update({ where: { id: order.id }, data: patch });
      updated++;
    }
  }

  const sampleKeys = items.length > 0 ? Object.keys(items[0]) : [];
  const sampleOrderFields = items.length > 0
    ? Object.fromEntries(Object.entries(items[0]).filter(([k]) => k.includes('order') || k.includes('no') || k.includes('id')))
    : {};

  return Response.json({ updated, unmatched, total: items.length, withOrderNo: withOrderNo.length, sampleKeys, sampleOrderFields, rawKeys });
}
