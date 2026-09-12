// Canonical-link selection for BFMR reservations. Pure (no prisma): given the
// set of OrderBfmrLink rows recalcBfmrSalePrice is about to sum, drop the
// phantom links that inflate salePrice/bgExpectedPayout -- the no-tracking
// PARENT link left behind after a reservation is split into per-shipment tracked
// children, and any duplicate that re-uses a trackingNumber already owned by
// another link. The dispatched task implements selectCanonicalBfmrLinks in THIS
// file only; recalc wiring is done separately by the reviewer.

export interface BfmrLinkLike {
  id: number;
  reservationId: number;
  trackingNumber: string | null;
}

// TODO(dispatch): return only the CANONICAL links.
// 1. Per reservationId: if the reservation has at least one tracked link
//    (trackingNumber non-null and non-empty), drop that reservation's
//    no-tracking "parent" link(s) -- they were superseded by the split.
//    A reservation with NO tracked link keeps its single no-tracking link
//    (an un-split reservation must NOT be emptied -- over-trigger guard).
// 2. A non-null trackingNumber must appear at most once in the output; on a
//    collision keep the link with the smallest id and drop the rest (removes a
//    duplicate re-using a tracking number owned by another reservation).
// Preserve every other field on the links that are kept; never mutate the input.
export function selectCanonicalBfmrLinks<T extends BfmrLinkLike>(links: T[]): T[] {
  return links;
}
