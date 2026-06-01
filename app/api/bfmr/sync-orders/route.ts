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

  // Load skip list
  const skipList = await prisma.bfmrSkip.findMany({ select: { orderNumber: true } });
  const skipSet = new Set(skipList.map(s => normalize(s.orderNumber)));

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

  // Group items by order number — same order can have multiple shipments
  const grouped = new Map<string, TrackerItem[]>();
  for (const item of withOrderNo) {
    const norm = normalize(item.order_id as string);
    if (!grouped.has(norm)) grouped.set(norm, []);
    grouped.get(norm)!.push(item);
  }

  let updated = 0;
  let unmatched = 0;
  let created = 0;

  for (const [norm, group] of grouped) {
    // Use best status across all shipments (paid > received > shipped > other)
    const STATUS_RANK: Record<string, number> = { paid: 5, payment_sent: 5, complete: 5, completed: 5, pkg_received: 4, received: 4, processed: 4, shipped: 3, purchased: 2 };
    const bestItem = group.reduce((a, b) => (STATUS_RANK[String(b.status ?? '').toLowerCase()] ?? 0) > (STATUS_RANK[String(a.status ?? '').toLowerCase()] ?? 0) ? b : a);
    const status = String(bestItem.status ?? '').toLowerCase();
    const activeItems = group.filter(i => !IGNORE_STATUSES.has(String(i.status ?? '').toLowerCase()));
    const totalPayout = activeItems.reduce((sum, i) => sum + (parseMoney(i.total_payout) ?? 0), 0) || null;
    const order = existingByNorm.get(norm);

    if (!order) {
      if (IMPORT_STATUSES.has(status) && !IGNORE_STATUSES.has(status) && !skipSet.has(norm)) {
        const isPaid = PAID_STATUSES.has(status);
        const isAmazonOrder = /^\d{3}-\d{7}-\d{7}$/.test(String(bestItem.order_id));
        const reservedAt = bestItem.reserved_at ? new Date(String(bestItem.reserved_at)) : new Date();
        const trackingNums = [...new Set(group.map(i => i.tracking_number).filter(Boolean))].join(', ');
        await prisma.order.create({
          data: {
            userId: uid,
            platform: isAmazonOrder ? 'Amazon' : 'Other',
            orderNumber: String(bestItem.order_id),
            orderDate: reservedAt,
            itemDescription: String(bestItem.item_name ?? bestItem.deal_title ?? ''),
            cost: 0,
            trackingNumbers: trackingNums || null,
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

    const receivedAt = bestItem.date_processed ? new Date(String(bestItem.date_processed)) : null;
    const isOverdue = isReceived && receivedAt != null &&
      Date.now() - receivedAt.getTime() > 14 * 24 * 60 * 60 * 1000 &&
      !isPaid;

    const patch: Record<string, unknown> = {};

    if (isPaid && totalPayout != null) {
      if (!order.salePriceSynced || force) {
        patch.salePrice = totalPayout;
        patch.salePriceSynced = true;
      }
    }
    if (isPaid && order.overdueAt) patch.overdueAt = null;
    if (isOverdue && !order.overdueAt) patch.overdueAt = new Date();
    if (order.buyerId == null && bfmrBuyer) patch.buyerId = bfmrBuyer.id;
    if (Object.keys(patch).length > 0) {
      await prisma.order.update({ where: { id: order.id }, data: patch });
      updated++;
    }
  }

  return Response.json({ updated, created, unmatched, total: items.length, withOrderNo: withOrderNo.length });
}
