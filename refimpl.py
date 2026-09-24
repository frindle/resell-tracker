#!/usr/bin/env python3
"""Reference impl for: rt-bfmr-pending-sync-scope-s3-export-function-resolveb

The gate applies this, runs the verify, and reverts it. It proves two things at
once: the task is SATISFIABLE as specified, and the verify actually ENFORCES the
spec (a refimpl that goes green while a "Must contain" literal is absent means
the verify is benign).

Adds resolveBfmrSyncPlan to lib/bfmrSyncScope.ts WITHOUT touching anything the
earlier slices already landed there (parseBfmrSyncScope, BFMR_ALL_TRACKER_STATUSES, ...).
"""
import pathlib
import sys

wt = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
p = wt / 'lib/bfmrSyncScope.ts'
t = p.read_text()

if 'resolveBfmrSyncPlan' in t:
    print("refimpl already applied -- nothing to do")
    sys.exit(0)

IMPORT = "import type { TrackerFilter } from './bfmr';\n\n"

NEW = r'''
/** A BFMR /my-tracker filter, as accepted by getMyTracker. */
export type BfmrTrackerFilter = TrackerFilter;

const ALL_SCOPE_FILTER: BfmrTrackerFilter = { status: BFMR_ALL_TRACKER_STATUSES.join(','), page_size: 200 };
const NARROW_SCOPE_FILTER: BfmrTrackerFilter = { quick_filter: 'action_needed', page_size: 200 };

export function resolveBfmrSyncPlan(scope: BfmrSyncScope): { filters: BfmrTrackerFilter[]; runWebBackfill: boolean; runStaleLinkScan: boolean; runAutoLink: boolean } {
  if (scope === 'all') {
    return { filters: [ALL_SCOPE_FILTER], runWebBackfill: true, runStaleLinkScan: true, runAutoLink: true };
  }
  return { filters: [NARROW_SCOPE_FILTER], runWebBackfill: false, runStaleLinkScan: false, runAutoLink: true };
}
'''

p.write_text(IMPORT + t.rstrip() + "\n" + NEW)
print("refimpl applied")
