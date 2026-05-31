import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import type { TrackerItem } from '@/lib/bfmr';
import { NextRequest } from 'next/server';

function normalize(n: string | null | undefined): string {
  return (n ?? '').replace(/\D/g, '');
}
function parseMoney(v: unknown): number | null {
  const n = parseFloat(String(v ?? '').replace(/,/g, ''));
  return isNaN(n) ? null : n;
}

export async function POST(req: NextRequest) {
  const userId = await getSessionUserId();
  const uid = userId ?? null;

  const body = await req.json() as { items: TrackerItem[]; force?: boolean };
  const items: TrackerItem[] = Array.isArray(body.items) ? body.items : [];
  const force = body.force ?? false;

  const PAID_STATUSES = new Set(['paid', 'payment_sent', 'complete', 'completed']);
  const RECEIVED_STATUSES = new Set(['pkg_received', 'received', 'processed']);
  const IMPORT_STATUSES = new Set(['paid', 'payment_sent', 'complete', 'completed', 'pkg_received', 'received', 'processed', 'shipped', 'purchased']);
  const IGNORE_STATUSES = new Set(['cancelled', 'returned', 'return', 'set_aside', 'closed']);

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
  let created = 0;

  for (const item of withOrderNo) {
    const norm = normalize(item.order_id as string);
    const status = String(item.status ?? '').toLowerCase();
    const order = existingByNorm.get(norm);

    if (!order) {
      // Create missing orders for active statuses only
      if (IMPORT_STATUSES.has(status) && !IGNORE_STATUSES.has(status)) {
        const isPaid = PAID_STATUSES.has(status);
        const totalPayout = parseMoney(item.total_payout);
        const isAmazonOrder = /^\d{3}-\d{7}-\d{7}$/.test(String(item.order_id));
        const reservedAt = item.reserved_at ? new Date(String(item.reserved_at)) : new Date();
        await prisma.order.create({
          data: {
            userId: uid,
            platform: isAmazonOrder ? 'Amazon' : 'Other',
            orderNumber: String(item.order_id),
            orderDate: reservedAt,
            itemDescription: String(item.item_name ?? item.deal_title ?? ''),
            cost: 0,
            trackingNumbers: item.tracking_number ? String(item.tracking_number) : null,
            buyerId: bfmrBuyer?.id ?? null,
            salePrice: isPaid && totalPayout ? totalPayout : null,
            salePriceSynced: isPaid,
            notes: 'Imported from BFMR – add cost, card, and shipping info',
          },
        });
        created++;
      } else {
        unmatched++;
      }
      continue;
    }

    const isPaid = PAID_STATUSES.has(status);
    const isReceived = RECEIVED_STATUSES.has(status);

    // Overdue: received >14 days ago and still not paid
    const receivedAt = item.date_processed ? new Date(item.date_processed as string) : null;
    const isOverdue = isReceived && receivedAt != null &&
      Date.now() - receivedAt.getTime() > 14 * 24 * 60 * 60 * 1000 &&
      !isPaid;

    const patch: Record<string, unknown> = {};

    const totalPayout = parseFloat(String(item.total_payout ?? '')) || null;
    if (isPaid) {
      if (force && totalPayout != null) {
        patch.salePrice = totalPayout;
      }
      if (!order.salePriceSynced) patch.salePriceSynced = true;
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

  return Response.json({ updated, created, unmatched, total: items.length, withOrderNo: withOrderNo.length });
}
