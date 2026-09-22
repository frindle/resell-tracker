// Pure invariant guard for OrderBfmrLink writes (no DB, no I/O — loads under
// `node --experimental-strip-types`). Two invariants, both of which the 907
// incident violated: a single RESERVATION must never carry two links with the
// same tracking number (one order can legitimately hold several reservations
// — e.g. multiple units of one item split across separate BFMR buyers — that
// all ship together under one shared tracking number, so that duplicate check
// is scoped per-reservation, not per-order), and the summed link.quantity
// against one reservation must never exceed that reservation's qty. Call
// guardLink BEFORE every create or update of an OrderBfmrLink; on
// { ok: false } skip (auto-link) or 409 (API).

export function normTracking(s: string | null | undefined): string {
  return (s ?? '').replace(/\s/g, '').toUpperCase();
}

export type GuardOrderLink = {
  id: number;
  reservationId: number;
  quantity: number;
  trackingNumber: string | null;
  // Split-family context (optional — callers without it are unaffected):
  /** The link's reservation's reserve_id. A BFMR SPLIT returns several lines
   *  sharing one reserve_id, so this is the family discriminator. */
  reserveId?: string | null;
  /** The link's reservation's last_synced_at (epoch ms). Rows still returned
   *  by BFMR carry a fresh timestamp; a pre-split parent row left behind
   *  locally carries an older one — that delta is what marks it stale. */
  lastSyncedAtMs?: number;
};

export type GuardParams = {
  orderId: number;
  reservationId: number;
  quantity: number;
  trackingNumber: string | null;
  /** The reservation's own qty — the budget this link draws against. */
  reservationQty: number;
  /** In-place update: skip comparing/summing this link against itself. */
  excludeLinkId?: number;
  /**
   * The reservation's OWN bfmrOrderId, as BFMR reported it. Optional: a caller
   * that doesn't know it gets exactly today's behaviour.
   */
  reservationBfmrOrderId?: string | null;
  /** The order's own orderNumber, to compare that claim against. */
  orderNumber?: string | null;
};

/**
 * Split-family coverage (orders 898/907 phantom-parent class).
 *
 * A BFMR split of a "purchased" reservation returns per-shipment child lines
 * that share the parent's reserve_id, and sync upserts them as SEPARATE
 * BfmrReservation rows — while the pre-split parent row (no tracking) stays
 * behind locally. autoLinkBfmrReservations then links every unlinked row by
 * bfmrOrderId, so guardLink's two invariants both pass for the stale parent
 * (different reservationId → no over-allocation; no tracking → no duplicate)
 * and it lands on top of its children: order 898 summed to $1116 instead of
 * $558. This is the missing third invariant, expressed as a number so the
 * caller can compare against the candidate's qty: an UNTRACKED candidate whose
 * units are already fully covered by sibling links in its reserve_id family is
 * a stale parent and must not be linked.
 */
export function splitSiblingCoverage(
  orderLinks: GuardOrderLink[],
  p: { reservationId: number; quantity: number; reserveId?: string | null },
): number {
  if (!p.reserveId) return 0;
  return orderLinks.reduce((sum, l) =>
    l.reservationId !== p.reservationId && (l.reserveId ?? '') === p.reserveId ? sum + l.quantity : sum,
    0);
}

/**
 * Stale-parent supersession (the "replace the no-tracking parent link" half of
 * the same defect). When a FRESH row (just synced — newer lastSyncedAt) is
 * about to be linked and an UNTRACKED sibling link in its reserve_id family was
 * synced EARLIER, that sibling is the pre-split snapshot: shrink it by the
 * candidate's quantity (0 = delete) so the same units are not counted twice.
 * Current rows — equal or newer timestamp, e.g. a legitimate split remainder —
 * are never touched, so a real {shipped half + unshipped remainder} pair still
 * sums to the full reservation instead of undercounting.
 */
export function staleSiblingAdjustments(
  orderLinks: GuardOrderLink[],
  p: {
    reservationId: number;
    quantity: number;
    reserveId?: string | null;
    lastSyncedAtMs?: number;
  },
): Array<{ linkId: number; newQuantity: number }> {
  if (!p.reserveId || typeof p.lastSyncedAtMs !== 'number') return [];
  let remaining = p.quantity;
  const out: Array<{ linkId: number; newQuantity: number }> = [];
  for (const l of orderLinks) {
    if (remaining <= 0) break;
    if (l.reservationId === p.reservationId) continue;
    if ((l.reserveId ?? '') !== p.reserveId) continue;
    // Only untracked snapshots are stale parents — a tracked sibling is a real
    // shipment line and must keep its units.
    if (normTracking(l.trackingNumber) !== '') continue;
    if (typeof l.lastSyncedAtMs !== 'number' || l.lastSyncedAtMs >= p.lastSyncedAtMs) continue;
    const take = Math.min(l.quantity, remaining);
    remaining -= take;
    out.push({ linkId: l.id, newQuantity: l.quantity - take });
  }
  return out;
}

export function guardLink(
  orderLinks: GuardOrderLink[],
  p: GuardParams,
): { ok: true } | { ok: false; reason: string } {
  // Third invariant, checked FIRST so a cross-order link is refused for the
  // right reason. Order 219 is the live case: reservation 103 carries BFMR
  // order 112-8973564-0951402 (an Apple Watch order that isn't even in the DB)
  // and attached to order 219 (AirPods Pro 3) purely because Amazon
  // consolidated both boxes under one tracking number. Tracking alone is not
  // evidence of the same order.
  if (reservationContradictsOrder(p.reservationBfmrOrderId, p.orderNumber)) {
    return {
      ok: false,
      reason: `reservation ${p.reservationId} belongs to BFMR order ${p.reservationBfmrOrderId}, not ${p.orderNumber} (order ${p.orderId})`,
    };
  }

  const t = normTracking(p.trackingNumber);
  if (t !== '') {
    for (const l of orderLinks) {
      if (l.id === p.excludeLinkId) continue;
      if (l.reservationId !== p.reservationId) continue;
      if (normTracking(l.trackingNumber) === t) {
        return {
          ok: false,
          reason: `duplicate tracking ${t} already on reservation ${p.reservationId} (order ${p.orderId}, link ${l.id})`,
        };
      }
    }
  }

  const existingQty = orderLinks.reduce(
    (sum, l) =>
      l.reservationId === p.reservationId && l.id !== p.excludeLinkId
        ? sum + l.quantity
        : sum,
    0,
  );
  if (existingQty + p.quantity > p.reservationQty) {
    return {
      ok: false,
      reason: `over-allocated: reservation ${p.reservationId} already has ${existingQty} linked units; adding ${p.quantity} exceeds its qty of ${p.reservationQty}`,
    };
  }

  return { ok: true };
}

/**
 * Digit-normalized, bidirectional, 7-digit-floor order-number comparison —
 * the same match lib/bfmrAutoLink.ts uses to attach a reservation by order
 * number. BFMR stores the retailer's order number as the seller typed it, so
 * separators and padding vary; the digits are the identity.
 */
export function orderNumbersAgree(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = (a ?? '').replace(/\D/g, '');
  const nb = (b ?? '').replace(/\D/g, '');
  if (na === '' || nb === '') return false;
  const shorter = na.length <= nb.length ? na : nb;
  if (shorter.length < 7) return false;
  return na.includes(nb) || nb.includes(na);
}

/**
 * True when the reservation's OWN bfmrOrderId names a DIFFERENT retailer order
 * than the one it is being linked to.
 *
 * Absent or too-short on EITHER side is UNKNOWN, never a contradiction:
 * legacy reservations carry no captured order number, and seven live orders
 * carry 'N/A' or nothing at all. An unknown must never refuse a link — this
 * only fires when both sides really name an order and the two disagree.
 */
export function reservationContradictsOrder(
  reservationBfmrOrderId: string | null | undefined,
  orderNumber: string | null | undefined,
): boolean {
  const rNorm = (reservationBfmrOrderId ?? '').replace(/\D/g, '');
  const oNorm = (orderNumber ?? '').replace(/\D/g, '');
  if (rNorm.length < 7 || oNorm.length < 7) return false;
  return !orderNumbersAgree(reservationBfmrOrderId, orderNumber);
}
