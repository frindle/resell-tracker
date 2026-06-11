import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import type { TrackerItem } from '@/lib/bfmr';
import { getShipmentStatus } from '@/lib/bfmr';
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

  // Load BFMR credentials for shipment status checks on processed transition
  const [apiKeySetting, apiSecretSetting, syncStartSetting] = await Promise.all([
    prisma.setting.findFirst({ where: { userId: uid, key: 'bfmr_api_key' } }),
    prisma.setting.findFirst({ where: { userId: uid, key: 'bfmr_api_secret' } }),
    prisma.setting.findFirst({ where: { userId: uid, key: 'bfmr_sync_start_date' } }),
  ]);
  const bfmrCreds = apiKeySetting?.value && apiSecretSetting?.value
    ? { apiKey: apiKeySetting.value, apiSecret: apiSecretSetting.value }
    : null;
  const syncStartCutoff = syncStartSetting?.value ? new Date(syncStartSetting.value) : null;

  const PAID_STATUSES = new Set(['paid', 'payment_sent', 'complete', 'completed']);
  const RECEIVED_STATUSES = new Set(['pkg received', 'received', 'processed']);
  const IMPORT_STATUSES = new Set(['paid', 'payment_sent', 'complete', 'completed', 'pkg received', 'received', 'processed', 'shipped', 'purchased']);
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
    select: { id: true, orderNumber: true, trackingNumbers: true, salePrice: true, salePriceSynced: true, bgExpectedPayout: true, bgPaidAmount: true, bgCredited: true, buyerId: true, buyerMismatch: true, buyer: { select: { name: true } }, overdueAt: true, lost: true, bfmrReceived: true, bfmrOrderId: true, bfmrStatus: true, bfmrRejectedItems: true },
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
      // Skip if this tracking number already appears in the group with an active (non-ignored) status —
      // the order-level entry already has the rolled-up payout and adding this shipment entry would double-count.
      // But if the existing item is a return/cancelled, still add the paid tracking-only item
      // since the return contributes $0 to payout and we'd lose the legitimate paid amount.
      const group = grouped.get(groupKey)!;
      const activeWithSameTracking = group.filter(gi =>
        normalize(gi.tracking_number as string) === t &&
        !IGNORE_STATUSES.has(String(gi.status ?? '').toLowerCase())
      );
      // Skip only if this looks like a duplicate: exactly one active item exists with the
      // same tracking AND the same payout (BG-style rollup entries). If multiple active items
      // already exist, this is an additional item (e.g. extra check-in) and should be counted.
      const isDuplicate = activeWithSameTracking.length === 1 &&
        Math.abs((parseMoney(activeWithSameTracking[0].total_payout) ?? 0) - (parseMoney(item.total_payout) ?? 0)) < 0.01;
      if (isDuplicate) continue;
      group.push(item);
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

    // Always update bgExpectedPayout when the calculated value changes meaningfully —
    // stale values from before return/double-count fixes would otherwise persist forever.
    if (totalPayout != null && (force || order.bgExpectedPayout == null || Math.abs((order.bgExpectedPayout ?? 0) - totalPayout) > 0.01)) {
      patch.bgExpectedPayout = totalPayout;
    }
    if (isPaid && totalPayout != null) {
      if (order.salePrice == null || force) patch.salePrice = totalPayout;
      // Always correct bgPaidAmount when it differs — stale values from before
      // return/double-count fixes must be cleared even when salePriceSynced=true.
      if (force || !order.salePriceSynced) patch.salePriceSynced = true;
      // Only defer to BG receipt sync (bgCredited) for non-BFMR orders.
      // For BFMR-assigned orders, FMRB sync is always authoritative for bgPaidAmount.
      const orderBuyerName = (order.buyer as { name?: string } | null)?.name ?? '';
      const orderIsBfmr = /bfmr/i.test(orderBuyerName);
      if (orderIsBfmr || !order.bgCredited || force) {
        if (force || order.bgPaidAmount == null || Math.abs((order.bgPaidAmount ?? 0) - totalPayout) > 0.01) {
          patch.bgPaidAmount = totalPayout;
        }
      }
    } else if (totalPayout != null && (force || order.salePrice == null)) {
      patch.salePrice = totalPayout;
    }
    if ((isPaid || isReceived) && !order.bfmrReceived) patch.bfmrReceived = true;
    if (status !== order.bfmrStatus) patch.bfmrStatus = status;
    if ((isPaid || isReceived) && order.overdueAt) patch.overdueAt = null;
    if (isOverdue && !order.salePriceSynced && !order.overdueAt) patch.overdueAt = new Date();
    if (order.buyerId == null && bfmrBuyer) patch.buyerId = bfmrBuyer.id;
    // Flag if assigned buyer looks like a BG (BigSkyBuyers) group but FMRB has the receipt
    const buyerName = (order.buyer as { name?: string } | null)?.name ?? '';
    const isBgBuyer = /bigsky|buyinggroup|buying.?group/i.test(buyerName);
    if (isBgBuyer && !order.buyerMismatch) patch.buyerMismatch = true;
    if (!isBgBuyer && order.buyerMismatch) patch.buyerMismatch = false;
    const bfmrTracking = [...new Set(group.map(i => i.tracking_number).filter(Boolean))].join(', ');
    if (bfmrTracking && !order.trackingNumbers) patch.trackingNumbers = bfmrTracking;

    // On transition to processed, fetch shipment status to check for rejected items
    const transitioningToProcessed = status === 'processed' && order.bfmrStatus !== 'processed';
    if (transitioningToProcessed && bfmrCreds) {
      const trackingsToCheck = [...new Set(group.map(i => i.tracking_number).filter(Boolean))] as string[];
      const rejected: { name: string; reason: string }[] = [];
      for (const t of trackingsToCheck) {
        try {
          const shipData = await getShipmentStatus(bfmrCreds, t) as Array<Record<string, unknown>>;
          for (const shipment of shipData) {
            const rejItems = shipment.rejected_items as Array<Record<string, unknown>> | undefined;
            if (rejItems?.length) {
              for (const item of rejItems) {
                const reasons = Array.isArray(item.issue_with_reason) ? item.issue_with_reason.join(', ') : String(item.issue_with_reason ?? '');
                rejected.push({ name: String(item.name ?? ''), reason: reasons });
              }
            }
          }
        } catch { /* don't fail sync if shipment check fails */ }
      }
      if (rejected.length > 0) patch.bfmrRejectedItems = JSON.stringify(rejected);
    }

    if (Object.keys(patch).length > 0) {
      await prisma.order.update({ where: { id: order.id }, data: patch });
      updated++;
    }
  }

  // Backfill: check shipment status for processed orders that never had rejection data captured
  if (bfmrCreds) {
    const needsCheck = await prisma.order.findMany({
      where: {
        ...(userId ? { userId } : { userId: null }),
        bfmrStatus: 'processed',
        bfmrRejectedItems: null,
        trackingNumbers: { not: null },
      },
      select: { id: true, trackingNumbers: true },
    });
    for (const o of needsCheck) {
      if (!o.trackingNumbers) continue;
      const trackings = o.trackingNumbers.split(',').map(s => s.trim()).filter(Boolean);
      const rejected: { name: string; reason: string }[] = [];
      for (const t of trackings) {
        try {
          const shipData = await getShipmentStatus(bfmrCreds, t) as Array<Record<string, unknown>>;
          for (const shipment of shipData) {
            const rejItems = shipment.rejected_items as Array<Record<string, unknown>> | undefined;
            if (rejItems?.length) {
              for (const item of rejItems) {
                const reasons = Array.isArray(item.issue_with_reason) ? item.issue_with_reason.join(', ') : String(item.issue_with_reason ?? '');
                rejected.push({ name: String(item.name ?? ''), reason: reasons });
              }
            }
          }
        } catch { /* don't fail sync */ }
      }
      // Store result either way — empty array means "checked, no rejections", so we use a sentinel
      await prisma.order.update({
        where: { id: o.id },
        data: { bfmrRejectedItems: rejected.length > 0 ? JSON.stringify(rejected) : '[]' },
      });
    }
  }

  return Response.json({ updated, created, unmatched, total: items.length, withOrderNo: withOrderNo.length });
}
