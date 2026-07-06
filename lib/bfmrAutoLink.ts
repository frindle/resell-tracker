import { prisma } from '@/lib/db';
import { recalcBfmrSalePrice } from '@/lib/bfmrSalePrice';

function normDigits(s: string | null | undefined): string {
  return (s ?? '').replace(/\D/g, '');
}

// Auto-link unlinked BFMR reservations to local orders. Two match signals,
// tried in order of strength:
//   1. bfmrOrderId ↔ order.orderNumber (exact normalized digits, or ≥7-digit
//      containment either way — BFMR sometimes stores partial numbers)
//   2. reservation.trackingNumber ↔ one of order.trackingNumbers (exact,
//      case-insensitive)
// Only reservations with zero existing links are considered so user-edited
// links are never stomped. Called from sync-reservations (all orders) and
// from the import route (scoped to just-created/updated orders) so a link
// lands no matter which side arrives first.
export async function autoLinkBfmrReservations(
  userId: number | null,
  orderIds?: number[],
): Promise<number> {
  const reservations = await prisma.bfmrReservation.findMany({
    where: {
      userId,
      orderLinks: { none: {} },
      OR: [{ bfmrOrderId: { not: null } }, { trackingNumber: { not: null } }],
      NOT: { status: { in: ['cancelled', 'canceled', 'closed'] } },
    },
    select: {
      id: true, bfmrOrderId: true, trackingNumber: true, qty: true, totalPayout: true,
    },
  });
  if (reservations.length === 0) return 0;

  const orders = await prisma.order.findMany({
    where: { userId, ...(orderIds ? { id: { in: orderIds } } : {}) },
    select: { id: true, orderNumber: true, trackingNumbers: true },
  });
  if (orders.length === 0) return 0;

  const ordersByNorm = new Map<string, number>();
  const ordersByTracking = new Map<string, number>();
  for (const o of orders) {
    const n = normDigits(o.orderNumber);
    if (n && !ordersByNorm.has(n)) ordersByNorm.set(n, o.id);
    for (const t of (o.trackingNumbers ?? '').split(',').map(s => s.trim()).filter(Boolean)) {
      const key = t.toUpperCase();
      if (!ordersByTracking.has(key)) ordersByTracking.set(key, o.id);
    }
  }

  function matchByOrderNumber(bfmrOrderIdRaw: string | null): number | undefined {
    if (!bfmrOrderIdRaw) return undefined;
    const rNorm = normDigits(bfmrOrderIdRaw);
    if (!rNorm) return undefined;
    const exact = ordersByNorm.get(rNorm);
    if (exact) return exact;
    let best: number | undefined;
    let bestLen = 0;
    for (const [oNorm, oid] of ordersByNorm.entries()) {
      const shorter = oNorm.length < rNorm.length ? oNorm : rNorm;
      const longer = oNorm.length < rNorm.length ? rNorm : oNorm;
      if (shorter.length >= 7 && longer.includes(shorter) && shorter.length > bestLen) {
        best = oid;
        bestLen = shorter.length;
      }
    }
    return best;
  }

  let linked = 0;
  const touchedOrderIds = new Set<number>();
  for (const r of reservations) {
    let orderId = matchByOrderNumber(r.bfmrOrderId);
    if (!orderId && r.trackingNumber) {
      orderId = ordersByTracking.get(r.trackingNumber.trim().toUpperCase());
    }
    if (!orderId) continue;
    try {
      await prisma.orderBfmrLink.create({
        data: {
          orderId,
          reservationId: r.id,
          trackingNumber: r.trackingNumber,
          quantity: r.qty,
          value: r.totalPayout,
        },
      });
      touchedOrderIds.add(orderId);
      linked++;
      console.log(`[bfmr/auto-link] reservation ${r.id} → order ${orderId} (${r.bfmrOrderId ? 'order#' : 'tracking'} match)`);
    } catch (e) {
      console.warn(`[bfmr/auto-link] failed to link reservation ${r.id} → order ${orderId}:`, e);
    }
  }

  for (const oid of touchedOrderIds) {
    await recalcBfmrSalePrice(oid);
  }
  return linked;
}
