#!/usr/bin/env python3
"""Reference impl for: rt-bfmr-pending-sync-scope-s1-the-exact-13-value-enum

The gate applies this, runs the verify, and reverts it. It proves two things at
once: the task is SATISFIABLE as specified, and the verify actually ENFORCES
the spec (a refimpl that goes green while a "Must contain" literal is absent
means the verify is benign).

The target already contains landed work from earlier slices (BfmrSyncScope +
parseBfmrSyncScope) -- this ADDS the 13-value status enum and its member type,
preserving everything else.
"""
import pathlib
import sys

wt = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
p = wt / 'lib/bfmrSyncScope.ts'
t = p.read_text()

OLD = r"""export type BfmrSyncScope = 'all' | 'pending';"""
NEW = r"""export type BfmrSyncScope = 'all' | 'pending';

/**
 * The exact 13-value BFMR tracker status enum that the sync-reservations route
 * pages over, in this order. Pure data -- no imports, no functions.
 */
export const BFMR_ALL_TRACKER_STATUSES = ['purchased', 'reserved', 'return', 'payment_error', 'shipped', 'processed', 'set_aside', 'paid', 'cancelled', 'returned', 'closed', 'deadline', 'pkg_received'] as const;

/** One of the 13 tracker statuses above. */
export type BfmrTrackerStatus = (typeof BFMR_ALL_TRACKER_STATUSES)[number];"""

assert OLD in t, "refimpl anchor not found -- did the target change?"
p.write_text(t.replace(OLD, NEW, 1))
print("refimpl applied")
