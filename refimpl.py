#!/usr/bin/env python3
"""Reference impl for: rt-bfmr-mytrackerid-preserve

The gate applies this, runs the verify, and reverts it. It proves two things at
once: the task is SATISFIABLE as specified, and the verify actually ENFORCES
the spec (a refimpl that goes green while a "Must contain" literal is absent
means the verify is benign).

The target file already contains the full sync route from earlier slices; this
refimpl makes ONLY the one-line change in the upsert's UPDATE branch and
preserves everything else. The anchor includes the two preceding lines so it
matches the UPDATE branch occurrence (which follows `datePaid,`) and NOT the
CREATE branch occurrence (which follows `totalPayout:`).
"""
import pathlib
import sys

wt = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
p = wt / 'app/api/bfmr/sync-reservations/route.ts'
t = p.read_text()

OLD = r'''        datePaid,
        raw: JSON.stringify(item),
        lastSyncedAt: new Date(),
        myTrackerId: item.my_tracker_id ? Number(item.my_tracker_id) : null,'''

NEW = r'''        datePaid,
        raw: JSON.stringify(item),
        lastSyncedAt: new Date(),
        ...(item.my_tracker_id ? { myTrackerId: Number(item.my_tracker_id) } : {}),'''

assert OLD in t, "refimpl anchor not found -- did the target change?"
p.write_text(t.replace(OLD, NEW, 1))
print("refimpl applied")
