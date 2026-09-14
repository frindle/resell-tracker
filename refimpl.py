#!/usr/bin/env python3
"""Reference impl for: bfmr-sync-orders-paginate

Swaps the sync-orders fetch:true block from the single-page getMyTracker to the
paginating getMyTrackerAll (import + call). This is the ONLY change. lib/bfmr.ts
already exports getMyTrackerAll (used by sync-reservations); do not touch it.
"""
import pathlib
import sys

wt = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
p = wt / 'app/api/bfmr/sync-orders/route.ts'
t = p.read_text()

OLD_IMPORT = "const { getMyTracker } = await import('@/lib/bfmr');"
NEW_IMPORT = "const { getMyTrackerAll } = await import('@/lib/bfmr');"
OLD_CALL = "items = await getMyTracker("
NEW_CALL = "items = await getMyTrackerAll("

assert OLD_IMPORT in t, "refimpl anchor (import) not found -- did the target change?"
assert OLD_CALL in t, "refimpl anchor (call) not found -- did the target change?"
t = t.replace(OLD_IMPORT, NEW_IMPORT, 1).replace(OLD_CALL, NEW_CALL, 1)
p.write_text(t)
print("refimpl applied: getMyTracker -> getMyTrackerAll")
