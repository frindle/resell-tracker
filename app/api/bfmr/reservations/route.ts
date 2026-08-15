import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const uid = await getSessionUserId();
  if (uid == null) return Response.json({ error: 'not authenticated' }, { status: 401 });

  const orderId = req.nextUrl.searchParams.get('orderId');

  const rowsAll = await prisma.bfmrReservation.findMany({
    where: { userId: uid },
    orderBy: { lastSyncedAt: 'desc' },
    include: {
      orderLinks: {
        include: {
          order: { select: { id: true, orderNumber: true, platform: true, trackingNumbers: true } },
        },
      },
      submittedShipments: true,
    },
  });

  // Cancel/recreate dedupe: when BFMR churns a reservation, the internalKey
  // stays the same across the cancelled + new rows. If we see a group
  // sharing the same key, hide the cancelled ones so the linker doesn't
  // over-count (the ASUS TUF 20/16 case).
  const cancelledStatuses = /^(cancel|cancell?ed|closed|removed|deleted)$/i;
  const activeKeys = new Set<string>();
  for (const r of rowsAll) {
    if (r.internalKey && !cancelledStatuses.test(r.status)) activeKeys.add(r.internalKey);
  }
  const rows = rowsAll.filter(r => {
    if (!r.internalKey) return true;
    if (!cancelledStatuses.test(r.status)) return true;
    // Cancelled row — hide only if an active row shares its key.
    return !activeKeys.has(r.internalKey);
  });

  const reservations = rows.map(r => ({
    id: r.id,
    reserveId: r.reserveId,
    purchaseId: r.purchaseId,
    shipmentId: r.shipmentId,
    bfmrOrderId: r.bfmrOrderId,
    myTrackerId: r.myTrackerId,
    dealId: r.dealId,
    itemId: r.itemId,
    trackingNumber: r.trackingNumber,
    dealTitle: r.dealTitle,
    itemName: r.itemName,
    status: r.status,
    qty: r.qty,
    // A trackingNumber on the synced row is BFMR's own ground truth that
    // this reservation shipped — trust it over our local ledger even if
    // BfmrSubmittedShipment never got a row written for it (e.g. it was
    // submitted before this bookkeeping existed, or via BFMR's own site).
    remainingQty: r.trackingNumber ? 0 : Math.max(0, r.qty - r.submittedShipments.reduce((s, x) => s + x.qty, 0)),
    retailPrice: r.retailPrice,
    totalPayout: r.totalPayout,
    datePaid: r.datePaid?.toISOString() ?? null,
    lastSyncedAt: r.lastSyncedAt.toISOString(),
    orderLinks: r.orderLinks.map(l => ({
      id: l.id,
      orderId: l.orderId,
      trackingNumber: l.trackingNumber,
      quantity: l.quantity,
      value: l.value,
      order: l.order,
    })),
  }));

  if (orderId) {
    const oid = parseInt(orderId);
    const order = await prisma.order.findUnique({
      where: { id: oid },
      select: { orderNumber: true, trackingNumbers: true },
    });
    if (!order) return Response.json({ reservations: [] });

    const norm = (order.orderNumber ?? '').replace(/\D/g, '');
    const matching = reservations.filter(r => {
      // Already linked to THIS order — always include.
      if (r.orderLinks.some(l => l.orderId === oid)) return true;

      const rNorm = (r.bfmrOrderId ?? '').replace(/\D/g, '');

      // If the reservation has no order number yet on the BFMR side, it's
      // a safe candidate to claim — but only if we have a tracking-number
      // signal that it's related to THIS order (otherwise the picker
      // surfaces every unrelated unclaimed reservation).
      if (!rNorm) {
        if (order.trackingNumbers && r.trackingNumber) {
          const orderTrackings = order.trackingNumbers.split(',').map(t => t.trim());
          if (orderTrackings.includes(r.trackingNumber)) return true;
        }
        return false;
      }

      // Reservation already has an order number on BFMR. Only show if it
      // matches THIS order number. Bidirectional containment with a 7-digit
      // minimum (BFMR users sometimes enter partial order numbers — the
      // middle segment of an Amazon ID for instance — so strict equality
      // misses real matches, but ≥7 digits prevents short-number false
      // positives).
      if (norm) {
        const shorter = norm.length < rNorm.length ? norm : rNorm;
        const longer  = norm.length < rNorm.length ? rNorm : norm;
        if (shorter.length >= 7 && longer.includes(shorter)) return true;
      }
      return false;
    });
    return Response.json({ reservations: matching });
  }

  return Response.json({ reservations });
}
