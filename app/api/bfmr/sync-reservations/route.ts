import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { getMyTracker, type TrackerFilter } from '@/lib/bfmr';
import { recalcBfmrSalePrice } from '@/lib/bfmrSalePrice';

export const dynamic = 'force-dynamic';

function normOrderNumber(s: string | null | undefined): string {
  return (s ?? '').replace(/\D/g, '');
}

function parseMoney(v: unknown): number | null {
  const n = parseFloat(String(v ?? '').replace(/,/g, ''));
  return isNaN(n) ? null : n;
}

export async function POST() {
  const userId = await getSessionUserId();
  const uid = userId ?? null;
  if (uid == null) return Response.json({ error: 'not authenticated' }, { status: 401 });

  const [apiKeySetting, apiSecretSetting] = await Promise.all([
    prisma.setting.findFirst({ where: { userId: uid, key: 'bfmr_api_key' } }),
    prisma.setting.findFirst({ where: { userId: uid, key: 'bfmr_api_secret' } }),
  ]);
  if (!apiKeySetting?.value || !apiSecretSetting?.value) {
    return Response.json({ error: 'BFMR API credentials not configured' }, { status: 400 });
  }
  const creds = { apiKey: apiKeySetting.value, apiSecret: apiSecretSetting.value };

  const filters: TrackerFilter[] = [
    { quick_filter: 'all', page_size: 200 },
    { quick_filter: 'paid', page_size: 200 },
    { quick_filter: 'closed', page_size: 200 },
  ];

  const allItems = new Map<string, Record<string, unknown>>();
  for (const f of filters) {
    const items = await getMyTracker(creds, f);
    for (const item of items) {
      const key = String(item.reserve_id ?? item.purchase_id ?? item.shipment_id ?? '');
      if (key && !allItems.has(key)) allItems.set(key, item as Record<string, unknown>);
    }
  }

  // Pre-load this user's orders so we can auto-link reservations whose
  // bfmrOrderId matches an order number. Keyed by normalized digits.
  const userOrders = await prisma.order.findMany({
    where: { userId: uid },
    select: { id: true, orderNumber: true },
  });
  const ordersByNorm = new Map<string, number>();
  for (const o of userOrders) {
    const n = normOrderNumber(o.orderNumber);
    if (n && !ordersByNorm.has(n)) ordersByNorm.set(n, o.id);
  }

  // Find the local order whose normalized number contains, equals, or is
  // contained by the BFMR order id. Requires ≥7 digits on the shorter side
  // to keep partial overlaps from causing false matches.
  function findMatchingOrderId(bfmrOrderIdRaw: string | null): number | undefined {
    if (!bfmrOrderIdRaw) return undefined;
    const rNorm = normOrderNumber(bfmrOrderIdRaw);
    if (!rNorm) return undefined;
    const exact = ordersByNorm.get(rNorm);
    if (exact) return exact;
    let best: number | undefined;
    let bestLen = 0;
    for (const [oNorm, oid] of ordersByNorm.entries()) {
      const shorter = oNorm.length < rNorm.length ? oNorm : rNorm;
      const longer  = oNorm.length < rNorm.length ? rNorm : oNorm;
      if (shorter.length >= 7 && longer.includes(shorter)) {
        if (shorter.length > bestLen) { best = oid; bestLen = shorter.length; }
      }
    }
    return best;
  }

  const autoLinkedOrderIds = new Set<number>();
  let synced = 0;
  let autoLinked = 0;
  for (const item of allItems.values()) {
    const reserveId = item.reserve_id ? String(item.reserve_id) : null;
    if (!reserveId) continue;

    const datePaidRaw = item.date_paid ? new Date(String(item.date_paid)) : null;
    const datePaid = datePaidRaw && !isNaN(datePaidRaw.getTime()) ? datePaidRaw : null;

    const reservation = await prisma.bfmrReservation.upsert({
      where: { userId_reserveId: { userId: uid, reserveId } },
      create: {
        userId: uid,
        reserveId,
        purchaseId: item.purchase_id ? String(item.purchase_id) : null,
        shipmentId: item.shipment_id ? String(item.shipment_id) : null,
        bfmrOrderId: item.order_id ? String(item.order_id) : null,
        trackingNumber: item.tracking_number ? String(item.tracking_number) : null,
        dealTitle: item.deal_title ? String(item.deal_title) : null,
        itemName: item.item_name ? String(item.item_name) : null,
        status: String(item.status ?? 'unknown'),
        qty: parseInt(String(item.qty ?? '1')) || 1,
        retailPrice: parseMoney(item.retail_price),
        totalPayout: parseMoney(item.total_payout),
        datePaid,
        raw: JSON.stringify(item),
        lastSyncedAt: new Date(),
        // Fields needed at tracking-submission time
        myTrackerId: item.my_tracker_id ? Number(item.my_tracker_id) : null,
        itemId: item.item_id ? Number(item.item_id) : null,
        dealId: item.deal_id ? Number(item.deal_id) : null,
      },
      update: {
        purchaseId: item.purchase_id ? String(item.purchase_id) : null,
        shipmentId: item.shipment_id ? String(item.shipment_id) : null,
        bfmrOrderId: item.order_id ? String(item.order_id) : null,
        trackingNumber: item.tracking_number ? String(item.tracking_number) : null,
        dealTitle: item.deal_title ? String(item.deal_title) : null,
        itemName: item.item_name ? String(item.item_name) : null,
        status: String(item.status ?? 'unknown'),
        qty: parseInt(String(item.qty ?? '1')) || 1,
        retailPrice: parseMoney(item.retail_price),
        totalPayout: parseMoney(item.total_payout),
        datePaid,
        raw: JSON.stringify(item),
        lastSyncedAt: new Date(),
        myTrackerId: item.my_tracker_id ? Number(item.my_tracker_id) : null,
        itemId: item.item_id ? Number(item.item_id) : null,
        dealId: item.deal_id ? Number(item.deal_id) : null,
      },
    });
    synced++;

    // Auto-link by bfmrOrderId → local order.orderNumber. Only links when
    // (a) BFMR reported an order id, (b) it matches one of our orders, and
    // (c) the reservation isn't already linked to anything. Linking on a
    // first-time match prevents stomping on user-edited links.
    const bfmrOrderId = reservation.bfmrOrderId;
    if (bfmrOrderId) {
      const localOrderId = findMatchingOrderId(bfmrOrderId);
      if (localOrderId) {
        const existingLink = await prisma.orderBfmrLink.findFirst({
          where: { reservationId: reservation.id },
          select: { id: true },
        });
        if (!existingLink) {
          await prisma.orderBfmrLink.create({
            data: {
              orderId: localOrderId,
              reservationId: reservation.id,
              trackingNumber: reservation.trackingNumber,
              quantity: reservation.qty,
              value: reservation.totalPayout,
            },
          });
          autoLinkedOrderIds.add(localOrderId);
          autoLinked++;
        }
      }
    }
  }

  // Refresh sale price on any orders that got auto-links so the user sees
  // the BFMR payout reflected immediately.
  for (const oid of autoLinkedOrderIds) {
    await recalcBfmrSalePrice(oid);
  }

  return Response.json({ synced, autoLinked });
}
