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

type LinkRow = { id: number; orderId: number; quantity: number; value: number | null; trackingNumber: string | null };

export type TrackingLinkAction =
  | { row: number; qty: number; trackingNumber: string; action: 'assigned'; linkId: number }
  | { row: number; qty: number; trackingNumber: string; action: 'split'; linkId: number; newLinkId: number }
  | { row: number; qty: number; trackingNumber: string; action: 'already-recorded'; linkId: number }
  | { row: number; qty: number; trackingNumber: string; action: 'skipped'; reason: string };

/**
 * Push a just-submitted tracking number onto the OrderBfmrLink it belongs to.
 *
 * Submitting tracking is the ONLY operation that authoritatively knows
 * "these N units, under this tracking number, against this reservation".
 * Until now it wrote a BfmrSubmittedShipment and stopped there, leaving the
 * link's tracking to a free-text dropdown in BfmrReservationLinker that has
 * no quantity awareness at all — so the split-shipment links the submit
 * itself describes had to be re-created by hand, and usually weren't.
 *
 * Deliberately conservative — it never guesses:
 *   - exactly one untracked link at the submitted qty  → set its tracking
 *   - exactly one untracked link LARGER than the qty   → split it (new link
 *     at the submitted qty carries the tracking, the original keeps the
 *     remainder), mirroring /api/bfmr/links/split including the
 *     value-proration rule
 *   - anything else (no candidate, several equally good ones, only
 *     already-tracked links) → leave the links alone and log why
 *
 * Rows are applied in order and each consumes at most one link, so a
 * two-row submit against a qty-2 link splits once and then assigns.
 */
export async function applySubmittedTrackingToLinks(
  reservationId: number,
  rows: Array<{ qty: number; trackingNumber: string }>,
): Promise<TrackingLinkAction[]> {
  const actions: TrackingLinkAction[] = [];
  let links: LinkRow[] = await prisma.orderBfmrLink.findMany({
    where: { reservationId },
    select: { id: true, orderId: true, quantity: true, value: true, trackingNumber: true },
    orderBy: { id: 'asc' },
  });
  if (links.length === 0) {
    for (const [i, r] of rows.entries()) {
      actions.push({ row: i, qty: r.qty, trackingNumber: r.trackingNumber, action: 'skipped', reason: 'reservation has no order links' });
    }
    return actions;
  }

  const touchedOrderIds = new Set<number>();
  const consumed = new Set<number>();
  const same = (a: string | null, b: string) => (a ?? '').trim().toUpperCase() === b.trim().toUpperCase();

  for (const [i, row] of rows.entries()) {
    const note = (action: TrackingLinkAction) => {
      actions.push(action);
      if (action.action === 'skipped') {
        console.log(`[bfmr/submit-tracking] reservation ${reservationId} row ${i} (qty ${row.qty}, ${row.trackingNumber}): no link touched — ${action.reason}`);
      }
    };

    // Idempotency: a re-submit of the same tracking must not split anything.
    const existing = links.find(l => same(l.trackingNumber, row.trackingNumber));
    if (existing) {
      consumed.add(existing.id);
      note({ row: i, qty: row.qty, trackingNumber: row.trackingNumber, action: 'already-recorded', linkId: existing.id });
      continue;
    }

    const available = links.filter(l => !consumed.has(l.id));
    const equalQty = available.filter(l => l.quantity === row.qty);
    const untrackedEqual = equalQty.filter(l => !l.trackingNumber);

    if (untrackedEqual.length === 1) {
      const target = untrackedEqual[0];
      await prisma.orderBfmrLink.update({ where: { id: target.id }, data: { trackingNumber: row.trackingNumber } });
      target.trackingNumber = row.trackingNumber;
      consumed.add(target.id);
      touchedOrderIds.add(target.orderId);
      note({ row: i, qty: row.qty, trackingNumber: row.trackingNumber, action: 'assigned', linkId: target.id });
      continue;
    }
    if (untrackedEqual.length > 1) {
      note({ row: i, qty: row.qty, trackingNumber: row.trackingNumber, action: 'skipped', reason: `${untrackedEqual.length} untracked links at qty ${row.qty} — ambiguous` });
      continue;
    }
    if (equalQty.length > 0) {
      note({ row: i, qty: row.qty, trackingNumber: row.trackingNumber, action: 'skipped', reason: `link(s) at qty ${row.qty} already carry a different tracking number` });
      continue;
    }

    const larger = available.filter(l => !l.trackingNumber && l.quantity > row.qty);
    if (larger.length !== 1) {
      note({
        row: i,
        qty: row.qty,
        trackingNumber: row.trackingNumber,
        action: 'skipped',
        reason: larger.length === 0
          ? `no untracked link with qty ≥ ${row.qty}`
          : `${larger.length} untracked links larger than qty ${row.qty} — ambiguous`,
      });
      continue;
    }

    // Split. Same rule as /api/bfmr/links/split: link.value is an ABSOLUTE
    // total for the whole link, not a per-unit rate, so it's divided by
    // quantity ratio — and the source's share is the remainder of the
    // sibling's, so the two always sum to exactly the original.
    const source = larger[0];
    const remainingQty = source.quantity - row.qty;
    let sourceValue = source.value;
    let siblingValue: number | null = null;
    if (source.value != null) {
      const perUnit = source.value / source.quantity;
      siblingValue = Math.round(perUnit * row.qty * 100) / 100;
      sourceValue = Math.round((source.value - siblingValue) * 100) / 100;
    }
    try {
      const [, sibling] = await prisma.$transaction([
        prisma.orderBfmrLink.update({ where: { id: source.id }, data: { quantity: remainingQty, value: sourceValue } }),
        prisma.orderBfmrLink.create({
          data: {
            orderId: source.orderId,
            reservationId,
            trackingNumber: row.trackingNumber,
            quantity: row.qty,
            value: siblingValue,
          },
        }),
      ]);
      source.quantity = remainingQty;
      source.value = sourceValue;
      links = [...links, { id: sibling.id, orderId: sibling.orderId, quantity: sibling.quantity, value: sibling.value, trackingNumber: sibling.trackingNumber }];
      consumed.add(sibling.id);
      touchedOrderIds.add(source.orderId);
      note({ row: i, qty: row.qty, trackingNumber: row.trackingNumber, action: 'split', linkId: source.id, newLinkId: sibling.id });
    } catch (e) {
      console.warn(`[bfmr/submit-tracking] split failed for reservation ${reservationId} link ${source.id}:`, e);
      note({ row: i, qty: row.qty, trackingNumber: row.trackingNumber, action: 'skipped', reason: 'split failed' });
    }
  }

  for (const oid of touchedOrderIds) {
    await recalcBfmrSalePrice(oid);
  }
  return actions;
}
