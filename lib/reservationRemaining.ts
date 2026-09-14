/**
 * Remaining ordered quantity for a BFMR reservation after subtracting per-link
 * CANCELLED and RETURNED units. recalcBfmrSalePrice only subtracts returned; an
 * item-level cancellation of one unit in a multi-unit linked order was never
 * accounted for, so the cancelled unit kept counting toward the reservation.
 * A cancelled (or returned) unit lowers `ordered` and therefore RAISES
 * `remaining`, reopening the reservation. Pure: no I/O, no imports.
 */
export interface ReservationLink { quantity: number; cancelledQty?: number; returnedQty?: number }

export interface ReservationCoverage { ordered: number; remaining: number; overfilled: boolean }

/** Effective units on one link -- floored at 0 even if cancelled/returned exceed quantity. */
const effectiveUnits = (l: ReservationLink): number => Math.max(0, l.quantity - (l.cancelledQty ?? 0) - (l.returnedQty ?? 0));

export function reservationRemaining(requiredQty: number, links: readonly ReservationLink[] | null | undefined): ReservationCoverage {
  const ordered = Array.isArray(links) ? links.reduce((sum, l) => sum + effectiveUnits(l), 0) : 0;
  return { ordered, remaining: Math.max(0, requiredQty - ordered), overfilled: ordered > requiredQty };
}
