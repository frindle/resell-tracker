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
 * fixed for the status badge by making "shipped" per-link. This module extracts
 * that notion so the render gate can be tested without a database — and, since
 * the live defect (a locally-attached tracking number reading as "Fully
 * submitted to BFMR" with zero real submissions), it now derives BOTH fields
 * from the actual submission record: `BfmrSubmittedShipment` rows written only
 * by a real POST to /api/bfmr/submit-reservation-tracking. A link counts as
 * shipped when one of those rows matches its tracking number (or, for the
 * whole-reservation legacy path, the reservation's own tracking number).
 */

export interface LinkSubmissionState {
  /** Whether THIS LINK is shipped — per-link, only from a matching submittedShipment. */
  shipped: boolean;
  /** Reservation units already submitted (sum of submittedShipments qty, clamped to [0, qty]). */
  submittedUnits: number;
  /** The reservation's total units. */
  totalUnits: number;
  /**
   * Whether THIS RESERVATION is over-allocated — strictly per-reservation:
   * true ONLY when the sum of its OWN BfmrSubmittedShipment rows exceeds its
   * OWN qty. Never pools across reservations, orders, or links. A row where
   * submitted units <= that reservation's qty can never be flagged, no matter
   * what other reservations on the same order have submitted.
   */
  overAllocated: boolean;
}

export function linkSubmissionState(
  link: { trackingNumber: string | null; quantity: number },
  reservation: { qty: number; remainingQty: number; trackingNumber: string | null; status?: string },
  submittedShipments: readonly { trackingNumber: string; qty: number }[] = [],
): LinkSubmissionState {
  // A link is shipped ONLY when a real BfmrSubmittedShipment matches its
  // tracking number. The mere presence of a locally-attached tracking number
  // (persisted by the dropdown with no BFMR push) must NOT count — that was
  // the live defect: "Fully submitted to BFMR" rendered while
  // submittedShipments=0 and the Submit button was hidden before the user
  // could ever push. Deliberately does NOT look at reservation.remainingQty
  // either: that is a whole-reservation fact, and gating on it is exactly the
  // split-shipment bug (an un-shipped link inheriting its shipped sibling's
  // "fully submitted" message).
  const hasSubmission = (trackingNumber: string | null): boolean =>
    trackingNumber != null && submittedShipments.some(s => s.trackingNumber === trackingNumber);

  const coversWholeReservation = link.quantity >= reservation.qty;
  const shipped = hasSubmission(link.trackingNumber) || (coversWholeReservation && hasSubmission(reservation.trackingNumber));

  // Both fields come from the same real record: submittedUnits is the sum of
  // the actual BfmrSubmittedShipment rows, clamped to [0, qty] so a negative
  // or over-claimed ledger can never render "-1 of 2" / "3 of 2". This
  // replaces the old `qty - remainingQty` derivation.
  const totalUnits = reservation.qty;
  const submittedSum = submittedShipments.reduce((sum, s) => sum + (Number(s.qty) || 0), 0);
  const submittedUnits = Math.min(totalUnits, Math.max(0, submittedSum));

  // Over-allocation is a fact about THIS RESERVATION ALONE: its own submission
  // records vs its own qty. The old render-side check `link.quantity >
  // reservation.remainingQty` was wrong in both confirmed incidents (2026-09):
  // remainingQty goes to 0 the moment a reservation is fully submitted OR
  // carries BFMR's own tracking number, so EVERY link on such a row — including
  // the one whose own submission filled exactly its share ("1 of 1 already
  // submitted") — read "this link over-allocates what remains". A row where
  // (submitted units) <= (that reservation's qty) can never over-allocate; only
  // a ledger that sums ABOVE the reservation's own qty is one. Computed from
  // the unclamped sum so an over-claimed ledger (2 submitted vs qty 1) still
  // flags even though remainingQty clamps at 0 and hides it.
  const overAllocated = submittedSum > totalUnits;

  return { shipped, submittedUnits, totalUnits, overAllocated };
}
