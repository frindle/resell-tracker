#!/usr/bin/env python3
"""Reference impl for: rt-costco-always-sites-s1-loginqueue-js-near-lines-s1-in-sidecar-src-loginqueu

The gate applies this, runs the verify, and reverts it. It proves two things at
once: the task is SATISFIABLE as specified, and the verify actually ENFORCES
the spec (a refimpl that goes green while a "Must contain" literal is absent
means the verify is benign).

Change made: Costco moves from opt-in to always-on in the login queue.
  - ALWAYS_SITES gains 'costco' (amazon/walmart order preserved, costco last)
  - OPT_IN_SITES is cleared so costco is never queued twice when the legacy
    costco_sidecar_enabled flag happens to be set.
Exactly two executable lines change; both are exercised by verify.test.ts.
"""
import pathlib
import sys

wt = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
p = wt / 'sidecar/src/loginQueue.js'
t = p.read_text()

OLD = """const ALWAYS_SITES = ['amazon', 'walmart'];
const OPT_IN_SITES = { costco: 'costco_sidecar_enabled' };"""
NEW = """const ALWAYS_SITES = ['amazon', 'walmart', 'costco'];
const OPT_IN_SITES = {};"""

assert OLD in t, "refimpl anchor not found -- did the target change?"
p.write_text(t.replace(OLD, NEW, 1))
print("refimpl applied")
