#!/usr/bin/env python3
"""Reference impl for: bfmr-paid-rollup-overcount

The gate applies this, runs the verify, and reverts it. It proves two things at
once: the task is SATISFIABLE as specified, and the verify actually ENFORCES the
spec (a refimpl that goes green while a "Must contain" literal is absent means
the verify is benign).

The simplest change that makes the verify pass is to add the pure helper to
lib/bfmr.ts -- the behavioural suite (lib/bfmrPaidRollup.test.ts) only imports
that. The route.ts wiring is unverifiable by this gate (check_literals targets
lib/bfmr.ts and the test drives the pure helper), so it is reviewed by eye
post-run; the refimpl deliberately does NOT touch route.ts.
"""
import pathlib
import sys

wt = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
p = wt / 'lib/bfmr.ts'
t = p.read_text()

HELPER = '''

// Roll up a matched order's paid state from its ACTIVE items, decoupled from the
// old "most-advanced item drives everything" logic that made a partially-paid
// split order (order 900: one leg paid, one still shipped) read as fully paid
// and lock. `isPaid`/`payoutOf` are injected so this stays pure and unit-testable.
export function computeBfmrPaidRollup<T>(
  activeItems: T[],
  isPaid: (item: T) => boolean,
  payoutOf: (item: T) => number | null,
): { allPaid: boolean; paidPayout: number | null; totalPayout: number | null } {
  if (activeItems.length === 0) {
    return { allPaid: false, paidPayout: null, totalPayout: null };
  }
  const sum = (arr: T[]) => arr.reduce((s, i) => s + (payoutOf(i) ?? 0), 0);
  const paidItems = activeItems.filter(isPaid);
  return {
    allPaid: paidItems.length === activeItems.length,
    paidPayout: sum(paidItems),
    totalPayout: sum(activeItems),
  };
}
'''

assert 'computeBfmrPaidRollup' not in t, "helper already present -- baseline not clean?"
p.write_text(t.rstrip() + '\n' + HELPER)
print("refimpl applied")
