#!/usr/bin/env python3
"""Reference impl for: rt-bfmr-409-logging-p1

The gate applies this, runs the verify, and reverts it. It proves two things at
once: the task is SATISFIABLE as specified, and the verify actually ENFORCES the
spec (a refimpl that goes green while a "Must contain" literal is absent means
the verify is benign).

Write the SIMPLEST change that makes the verify pass. It doubles as your review
reference when the model's diff comes back.
"""
import pathlib
import sys

wt = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
p = wt / 'app/api/bfmr/submit-reservation-tracking/route.ts'
t = p.read_text()

# 1) import the existing helper (same idiom as lib/autoSubmitTracking.ts etc.)
OLD_IMPORT = "import { recalcBfmrSalePrice } from '@/lib/bfmrSalePrice';"
NEW_IMPORT = ("import { recalcBfmrSalePrice } from '@/lib/bfmrSalePrice';\n"
              "import { logApiError } from '@/lib/apiErrorLog';")

# 2) export a pure helper that decides WHICH early-409 branch applies, so the
#    two branches are testable without a DB/Next runtime. bfmrOrderId is checked
#    FIRST (matching the route's existing order).
OLD_HELPER = "export async function POST(req: Request) {"
NEW_HELPER = """// Which of the two early-409 preconditions fails for this reservation, or null
// when both IDs are present and submission may proceed. Pure + exported so the
// branch decision is testable without a DB/Next runtime; bfmrOrderId is checked
// first (the route's existing order).
export function findMissingBfmrId(reservation: {
  bfmrOrderId?: string | null;
  myTrackerId?: number | null;
}): 'bfmrOrderId' | 'myTrackerId' | null {
  if (!reservation.bfmrOrderId) return 'bfmrOrderId';
  if (reservation.myTrackerId == null) return 'myTrackerId';
  return null;
}

export async function POST(req: Request) {"""

# 3) first 409 site: reservation has no bfmrOrderId -> now logged + queryable
OLD_1 = """    if (!reservation.bfmrOrderId) {
      return Response.json({
        error: 'reservation has no order number yet — link it to an order (or sync from BFMR) first.',
      }, { status: 409 });
    }"""
NEW_1 = """    if (!reservation.bfmrOrderId) {
      void logApiError({
        userId,
        group: 'BFMR',
        endpoint: '/api/bfmr/submit-reservation-tracking',
        method: 'POST',
        status: 409,
        context: `reservation ${reservationId} has no bfmrOrderId — cannot submit tracking`,
      });
      return Response.json({
        error: 'reservation has no order number yet — link it to an order (or sync from BFMR) first.',
      }, { status: 409 });
    }"""

# 4) second 409 site: reservation has no myTrackerId -> now logged + queryable
OLD_2 = """    if (reservation.myTrackerId == null) {
      return Response.json({
        error: 'reservation has no BFMR tracker id yet — sync reservations from BFMR first (needed to target the right tracker row when the order is split across reservations).',
      }, { status: 409 });
    }"""
NEW_2 = """    if (reservation.myTrackerId == null) {
      void logApiError({
        userId,
        group: 'BFMR',
        endpoint: '/api/bfmr/submit-reservation-tracking',
        method: 'POST',
        status: 409,
        context: `reservation ${reservationId} has no myTrackerId — cannot submit tracking`,
      });
      return Response.json({
        error: 'reservation has no BFMR tracker id yet — sync reservations from BFMR first (needed to target the right tracker row when the order is split across reservations).',
      }, { status: 409 });
    }"""

for old, new in ((OLD_IMPORT, NEW_IMPORT), (OLD_HELPER, NEW_HELPER), (OLD_1, NEW_1), (OLD_2, NEW_2)):
    assert old in t, f"refimpl anchor not found -- did the target change? {old[:60]!r}"
    t = t.replace(old, new, 1)

p.write_text(t)
print("refimpl applied")
