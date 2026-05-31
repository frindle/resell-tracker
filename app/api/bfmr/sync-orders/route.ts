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

  const body = await req.json() as { items: TrackerItem[]; force?: boolean };
  const items: TrackerItem[] = Array.isArray(body.items) ? body.items : [];
  const force = body.force ?? false;

  const PAID_STATUSES = new Set(['paid', 'payment_sent', 'complete', 'completed']);
  const RECEIVED_STATUSES = new Set(['pkg_received', 'received', 'processed']);

  // Only items with an order number
  const withOrderNo = items.filter(i => i.order_id);

  // Find BFMR buyer for auto-assignment
  const bfmrBuyer = await prisma.buyer.findFirst({
    where: { name: { contains: 'BFMR' } },
  });

  // Fetch existing orders for this user
  const existing = await prisma.order.findMany({
    where: uid ? { userId: uid } : { userId: null },
    select: { id: true, orderNumber: true, trackingNumbers: true, salePrice: true, salePriceSynced: true, buyerId: true, overdueAt: true },
  });
  const existingByNorm = new Map(
    existing.filter(o => normalize(o.orderNumber)).map(o => [normalize(o.orderNumber!), o])
  );
  // Also build tracking lookup
  const existingByTracking = new Map<string, typeof existing[0]>();
  for (const o of existing) {
    if (!o.trackingNumbers) continue;
    for (const t of o.trackingNumbers.split(',').map(s => s.trim()).filter(Boolean)) {
      existingByTracking.set(normalize(t), o);
    }
  }

  let updated = 0;
  let unmatched = 0;

  for (const item of withOrderNo) {
    const norm = normalize(item.order_id as string);
    const trackingNorm = normalize(String(item.tracking_number ?? item.tracking ?? ''));
    const order = existingByNorm.get(norm) ?? (trackingNorm ? existingByTracking.get(trackingNorm) : undefined);

    if (!order) {
      unmatched++;
      continue;
    }

    const status = String(item.status ?? '').toLowerCase();
    const isPaid = PAID_STATUSES.has(status);
    const isReceived = RECEIVED_STATUSES.has(status);

    // Only set sale price once BFMR has actually paid
    const bfmrSalePrice = isPaid
      ? (parseFloat(String(item.amount_paid || item.sub_total || item.total_payout || '')) || null)
      : null;

    // Overdue: received >14 days ago and still not paid
    const receivedAt = item.date_processed ? new Date(item.date_processed as string) : null;
    const isOverdue = isReceived && receivedAt != null &&
      Date.now() - receivedAt.getTime() > 14 * 24 * 60 * 60 * 1000 &&
      !isPaid;

    const patch: Record<string, unknown> = {};

    if (bfmrSalePrice != null) {
      const pricesMatch = order.salePrice != null &&
        Math.abs(order.salePrice - bfmrSalePrice) < 0.01;
      if (force || order.salePrice == null || order.salePriceSynced || pricesMatch) {
        patch.salePrice = bfmrSalePrice;
        patch.salePriceSynced = true;
      }
    }
    if (isPaid && order.overdueAt) patch.overdueAt = null;
    if (isOverdue && !order.overdueAt) patch.overdueAt = new Date();
    if (order.buyerId == null && bfmrBuyer) {
      patch.buyerId = bfmrBuyer.id;
    }
    if (Object.keys(patch).length > 0) {
      await prisma.order.update({ where: { id: order.id }, data: patch });
      updated++;
    }
  }

  return Response.json({ updated, unmatched, total: items.length, withOrderNo: withOrderNo.length });
}
