/**
 * Decides whether linking an order to a BFMR reservation should push the order
 * number to BFMR.
 *
 * This lived inline in app/api/bfmr/links/route.ts as a boolean expression, and
 * it was wrong in a way an inline condition made hard to see: it was gated on
 * `!existing`, meaning "only the first time this exact link is created". Since
 * `389b575` put the qty box directly on the row, link-then-adjust-qty is the
 * normal flow -- and an adjust is an update, not a create, so the push was
 * skipped. The order number silently never reached BFMR for any edited link.
 *
 * The guard was trying to express "don't send the same order number twice".
 * That is a statement about the RESERVATION's recorded order number, not about
 * whether a link row happens to exist already, so it is expressed that way here.
 *
 * Separated from the route so the decision can be tested without a database.
 */

export interface PushGateInput {
  /** The order's number, if it has one yet. */
  orderNumber: string | null;
  /** BFMR's own tracker row id. Null until a sync backfills it. */
  myTrackerId: number | null;
  /** The order number already recorded on the reservation, if any. */
  reservationBfmrOrderId: string | null;
  /** Units this link covers. */
  quantity: number;
  /** The reservation's total units, if known. */
  reservationQty: number | null;
}

export type PushGateDecision =
  | { push: true; partial: boolean }
  | { push: false; reason: string };

/**
 * A push covers a partial link when it claims fewer units than the reservation
 * holds. BFMR has no split endpoint -- posting a smaller qty against the row IS
 * the split -- so this is worth naming rather than recomputing at the call site.
 */
export function isPartialLink(quantity: number, reservationQty: number | null): boolean {
  return reservationQty != null && quantity < reservationQty;
}

export function shouldPushOrderNumber(input: PushGateInput): PushGateDecision {
  const { orderNumber, myTrackerId, reservationBfmrOrderId, quantity, reservationQty } = input;

  if (!orderNumber) {
    return { push: false, reason: 'order has no order number yet' };
  }

  // Deliberately checked BEFORE the already-pushed test. A reservation with no
  // tracker id cannot be pushed to at all, and reporting that is the whole
  // point: this condition made the push a no-op on 708/708 reservations without
  // ever saying so.
  if (myTrackerId == null) {
    return { push: false, reason: 'reservation has no myTrackerId — sync reservations from BFMR first' };
  }

  // The real "don't repeat yourself" rule. Note it compares the NUMBER, so a
  // reservation that already carries a DIFFERENT order number still pushes --
  // that is the split case, where the remainder legitimately gets a second,
  // different order number.
  if (reservationBfmrOrderId != null && reservationBfmrOrderId === orderNumber) {
    return { push: false, reason: 'reservation already carries this order number' };
  }

  return { push: true, partial: isPartialLink(quantity, reservationQty) };
}
