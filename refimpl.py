#!/usr/bin/env python3
"""Reference impl for: bfmr-sync-reservations-500-guard

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
p = wt / 'app/api/bfmr/sync-reservations/route.ts'
t = p.read_text()

OLD = """  const filterResults = await Promise.all(filters.map(f => getMyTrackerAll(creds, f)));"""
NEW = """  const filterResults = await (async () => {
    try {
      return await Promise.all(filters.map(f => getMyTrackerAll(creds, f)));
    } catch (e) {
      return { __bfmrError: true, status: 502, message: `BFMR fetch failed: ${String(e)}` } as const;
    }
  })();
  if (filterResults && typeof filterResults === 'object' && '__bfmrError' in filterResults) {
    return Response.json({ error: filterResults.message }, { status: filterResults.status });
  }"""

assert OLD in t, "refimpl anchor not found -- did the target change?"
p.write_text(t.replace(OLD, NEW, 1))
print("refimpl applied")
