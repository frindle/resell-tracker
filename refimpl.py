#!/usr/bin/env python3
"""Reference impl for: rt-amazon-card-lastfours

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
p = wt / 'app/api/import/route.ts'
t = p.read_text()

OLD = """      if (lf.last4 && !c.last4) {  // Only add if it's not already in primary last4"""
NEW = """      if (lf.last4) {  // register regardless of a primary last4; same duplicate-collision handling as the branch above"""

assert OLD in t, "refimpl anchor not found -- did the target change?"
p.write_text(t.replace(OLD, NEW, 1))
print("refimpl applied")
