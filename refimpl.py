#!/usr/bin/env python3
"""Reference impl for: rt-costco-always-sites-s2-costco-to-always-sites

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
p = wt / 'sidecar/src/loginQueue.js'
t = p.read_text()

OLD = """const ALWAYS_SITES = ['amazon', 'walmart'];
const OPT_IN_SITES = { costco: 'costco_sidecar_enabled' };"""
NEW = """const ALWAYS_SITES = ['amazon', 'walmart', 'costco'];
const OPT_IN_SITES = {};"""

assert OLD in t, "refimpl anchor not found -- did the target change?"
t = t.replace(OLD, NEW, 1)

OLD2 = "module.exports = { sitesNeedingLogin, runQueueOnce };"
NEW2 = "module.exports = { sitesNeedingLogin, runQueueOnce, activeSites, isEnabled };"
assert OLD2 in t, "refimpl export anchor not found -- did the target change?"
t = t.replace(OLD2, NEW2, 1)

p.write_text(t)
print("refimpl applied")
