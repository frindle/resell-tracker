#!/usr/bin/env python3
import pathlib, sys
wt = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
p = wt / 'lib/reservationRemaining.ts'
IMPL = r'''// Pure fulfillment math for a BFMR reservation: how many units are still
// needed, accounting for per-link cancelled AND returned units. A cancelled or
// returned unit reduces `ordered` and so RAISES `remaining` (reopens the
// reservation). Used when an order moves/re-links between groups and when an
// item-level cancellation is detected on scrape. No I/O.

export interface ReservationLink {
  quantity: number;
  cancelledQty?: number;
  returnedQty?: number;
}

export interface ReservationCoverage {
  ordered: number;
  remaining: number;
  overfilled: boolean;
}

export function reservationRemaining(requiredQty: number, links: ReservationLink[]): ReservationCoverage {
  const list = Array.isArray(links) ? links : [];
  const ordered = list.reduce((sum, l) => {
    const effective = Math.max(0, (l?.quantity ?? 0) - (l?.cancelledQty ?? 0) - (l?.returnedQty ?? 0));
    return sum + effective;
  }, 0);
  const remaining = Math.max(0, requiredQty - ordered);
  const overfilled = ordered > requiredQty;
  return { ordered, remaining, overfilled };
}
'''
p.write_text(IMPL)
assert 'reservationRemaining' in IMPL and 'cancelledQty' in IMPL and 'overfilled' in IMPL
print("refimpl applied")
