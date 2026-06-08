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
  let items: TrackerItem[] = Array.isArray(body.items) ? body.items : [];
  const force = body.force ?? false;

  // Sync start date — only used to gate NEW order creation, not status updates on existing orders
  const syncStartSetting = await prisma.setting.findFirst({ where: { userId: uid, key: 'bfmr_sync_start_date' } });
  const syncStartCutoff = syncStartSetting?.value ? new Date(syncStartSetting.value) : null;

  const PAID_STATUSES = new Set(['paid', 'payment_sent', 'complete', 'completed']);
  const RECEIVED_STATUSES = new Set(['pkg_received', 'received', 'processed']);
  const IMPORT_STATUSES = new Set(['paid', 'payment_sent', 'complete', 'completed', 'pkg_received', 'received', 'processed', 'shipped', 'purchased']);
  const IGNORE_STATUSES = new Set(['cancelled', 'returned', 'return', 'set_aside', 'closed']);

  // Items with an order number, plus items with only a tracking number (no order_id)
  // — the no-order-id items get attached to groups via tracking number merge below
  const withOrderNo = items.filter(i => i.order_id);
  const trackingOnlyItems = items.filter(i => !i.order_id && i.tracking_number);

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
    select: { id: true, orderNumber: true, trackingNumbers: true, salePrice: true, salePriceSynced: true, bgExpectedPayout: true, bgPaidAmount: true, buyerId: true, overdueAt: true, lost: true, bfmrReceived: true, bfmrOrderId: true, bfmrStatus: true },
  });
  // bfmrOrderId override takes priority over orderNumber for matching
  const existingByNorm = new Map(
    existing.filter(o => normalize(o.orderNumber)).map(o => [normalize(o.orderNumber!), o])
  );
  for (const o of existing) {
    const overrideNorm = normalize(o.bfmrOrderId);
    if (overrideNorm) existingByNorm.set(overrideNorm, o);
  }
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

  // Merge groups that share a tracking number only when both groups lack an order number
  // match in the DB — meaning they're truly the same order split across BFMR entries.
  // If both groups have matching orders, keep them separate so each gets updated.
  const trackingToGroupKey = new Map<string, string>();
  const mergedGroupKeys = new Set<string>();
  for (const [norm, group] of grouped) {
    for (const item of group) {
      const t = normalize(item.tracking_number as string);
      if (!t) continue;
      const existing = trackingToGroupKey.get(t);
      if (existing && existing !== norm) {
        // Only merge if the incoming group has no direct order number match in DB
        const hasOwnMatch = existingByNorm.has(norm);
        if (!hasOwnMatch) {
          grouped.get(existing)!.push(...group);
          mergedGroupKeys.add(norm);
        }
      } else {
        trackingToGroupKey.set(t, norm);
      }
    }
  }
  for (const key of mergedGroupKeys) grouped.delete(key);

  // Fold tracking-only items (no order_id) into any group sharing their tracking number.
  // If no matching group exists, create a standalone group keyed by tracking number
  // so they can still match an existing order via tracking lookup.
  for (const item of trackingOnlyItems) {
    const t = normalize(item.tracking_number as string);
    if (!t) continue;
    const groupKey = trackingToGroupKey.get(t);
    if (groupKey && grouped.has(groupKey)) {
      grouped.get(groupKey)!.push(item);
    } else {
      // Standalone tracking-only group — can match an existing order by tracking
      const standaloneKey = `tracking:${t}`;
      if (!grouped.has(standaloneKey)) grouped.set(standaloneKey, []);
      grouped.get(standaloneKey)!.push(item);
    }
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
    const totalPayoutRaw = activeItems.reduce((sum, i) => sum + (parseMoney(i.total_payout) ?? 0), 0);
    const totalPayout = activeItems.length > 0 ? totalPayoutRaw : null;
    const bfmrTrackings = [...new Set(group.map(i => i.tracking_number).filter(Boolean))];
    const orderByTracking = bfmrTrackings.map(t => existingByTracking.get(normalize(t as string))).find(Boolean);
    const order = existingByNorm.get(norm) ?? orderByTracking;

    if (!order) {
      // Apply sync start date filter only when creating new orders
      const reservedAtDate = bestItem.reserved_at ? new Date(String(bestItem.reserved_at)) : null;
      const beforeCutoff = syncStartCutoff && reservedAtDate && reservedAtDate < syncStartCutoff;
      if (IMPORT_STATUSES.has(status) && !IGNORE_STATUSES.has(status) && !skipSet.has(norm) && !beforeCutoff) {
        const isPaid = PAID_STATUSES.has(status);
        const isReceivedNew = RECEIVED_STATUSES.has(status);
        const isAmazonOrder = /^\d{3}-\d{7}-\d{7}$/.test(String(bestItem.order_id));
        const reservedAt = reservedAtDate ?? new Date();
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
            salePrice: totalPayout ?? null,
            salePriceSynced: isPaid,
            bgExpectedPayout: totalPayout,
            bfmrReceived: isPaid || isReceivedNew,
            bfmrStatus: status,
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

    if (order.lost) continue;

    const patch: Record<string, unknown> = {};

    if (totalPayout != null && (force || order.bgExpectedPayout == null)) {
      patch.bgExpectedPayout = totalPayout;
    }
    if (isPaid && totalPayout != null) {
      if (order.salePrice == null || force) patch.salePrice = totalPayout;
      if (!order.salePriceSynced || force) {
        patch.salePriceSynced = true;
        patch.bgPaidAmount = totalPayout;
      }
    } else if (isReceived && totalPayout != null && (force || order.salePrice == null)) {
      patch.salePrice = totalPayout;
    }
    if ((isPaid || isReceived) && !order.bfmrReceived) patch.bfmrReceived = true;
    if (status !== order.bfmrStatus) patch.bfmrStatus = status;
    if ((isPaid || isReceived) && order.overdueAt) patch.overdueAt = null;
    if (isOverdue && !order.salePriceSynced && !order.overdueAt) patch.overdueAt = new Date();
    if (order.buyerId == null && bfmrBuyer) patch.buyerId = bfmrBuyer.id;
    const bfmrTracking = [...new Set(group.map(i => i.tracking_number).filter(Boolean))].join(', ');
    if (bfmrTracking && !order.trackingNumbers) patch.trackingNumbers = bfmrTracking;
    if (Object.keys(patch).length > 0) {
      await prisma.order.update({ where: { id: order.id }, data: patch });
      updated++;
    }
  }

  return Response.json({ updated, created, unmatched, total: items.length, withOrderNo: withOrderNo.length });
}
