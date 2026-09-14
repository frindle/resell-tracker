#!/usr/bin/env python3
"""Reference impl for: rt-cancelled-no-reservation-chip

The gate applies this, runs the verify, and reverts it. It proves two things at
once: the task is SATISFIABLE as specified, and the verify actually ENFORCES
the spec (a refimpl that goes green while a "Must contain" literal is absent
means the verify is benign).

Write the SIMPLEST change that makes the verify pass. It doubles as your review
reference when the model's diff comes back.
"""
import pathlib
import sys

wt = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
p = wt / 'app/orders/page.tsx'
t = p.read_text()

PREDICATE = """// 'No reservation' chip: a BFMR order with no linked reservation, no BFMR sync
// status, and an unsynced sale price. Cancelled orders never need a
// reservation, so they are excluded (matching the sibling chips).
export function shouldShowNoReservationChip(o: Order): boolean {
  return !o.cancelled && (o.bfmrLinks ?? []).length === 0 && !o.bfmrStatus && !o.salePriceSynced && /bfmr/i.test(o.buyer?.name ?? '');
}

"""

ANCHOR = "function GroupWarningChips({ o }: { o: Order }) {"
assert ANCHOR in t, "refimpl anchor not found -- did the target change?"
if 'shouldShowNoReservationChip' not in t:
    t = t.replace(ANCHOR, PREDICATE + ANCHOR, 1)

OLD = """      {(o.bfmrLinks ?? []).length === 0 && !o.bfmrStatus && !o.salePriceSynced && /bfmr/i.test(o.buyer.name) && (
        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-yellow-900/50 text-yellow-300 w-fit" title="Not linked to a BFMR reservation">"""
NEW = """      {shouldShowNoReservationChip(o) && (
        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-yellow-900/50 text-yellow-300 w-fit" title="Not linked to a BFMR reservation">"""
if OLD in t:
    t = t.replace(OLD, NEW, 1)

p.write_text(t)
print("refimpl applied")
