/**
 * Per-link submission state for a BFMR reservation link.
 *
 * This lived inline in components/BfmrReservationLinker.tsx as the render gate
 * `{r.remainingQty <= 0 ? ...}`, and it was wrong in a way an inline condition
 * made hard to see: `remainingQty` is a fact about the WHOLE reservation, but
 * the message it gated ("Fully submitted to BFMR — N of N shipped.") rendered
 * PER-LINK. Once one link of a split shipment consumed the reservation's
 * remaining qty (e.g. a 2-unit link with tracking on a qty-2 reservation), its
 * un-shipped sibling inherited "fully submitted / fully shipped" too, and the
 * count was hardcoded `{r.qty} of {r.qty}` so it could never show a partial.
 *
 * The same bug class `linkStatusLabel` (in BfmrReservationLinker.tsx) already
 * fixed for the status badge by making "shipped" per-link: a link counts as
 * shipped when that link carries tracking, or when it covers the whole
 * reservation and the reservation itself has tracking. This module extracts
 * that same notion so the render gate can be tested without a database.
 */

export interface LinkSubmissionState {
  /** Whether THIS LINK is shipped — per-link, never derived from remainingQty. */
  shipped: boolean;
  /** Reservation units already submitted (qty - remainingQty, clamped to [0, qty]). */
  submittedUnits: number;
  /** The reservation's total units. */
  totalUnits: number;
}

export function linkSubmissionState(
  link: { trackingNumber: string | null; quantity: number },
  reservation: { qty: number; remainingQty: number; trackingNumber: string | null; status?: string },
): LinkSubmissionState {
  // Same per-link notion as linkStatusLabel. Deliberately does NOT look at
  // reservation.remainingQty: that is a whole-reservation fact, and gating on
  // it is exactly the split-shipment bug (an un-shipped link inheriting its
  // shipped sibling's "fully submitted" message).
  const coversWholeReservation = link.quantity >= reservation.qty;
  const shipped = !!link.trackingNumber || (coversWholeReservation && !!reservation.trackingNumber);

  const totalUnits = reservation.qty;
  const submittedUnits = Math.min(totalUnits, Math.max(0, reservation.qty - reservation.remainingQty));

  return { shipped, submittedUnits, totalUnits };
}
