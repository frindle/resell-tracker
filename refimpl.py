#!/usr/bin/env python3
"""Reference impl for: rt-costco-always-sites-s1-loginqueue-js-near-lines

The gate applies this, runs the verify, and reverts it. It proves two things at
once: the task is SATISFIABLE as specified, and the verify actually ENFORCES the
spec (a refimpl that goes green while a "Must contain" literal is absent means
the verify is benign).

The site policy itself (ALWAYS_SITES = amazon+walmart always-on; costco opt-in
via OPT_IN_SITES -> 'costco_sidecar_enabled') already holds in the target. The
missing piece the spec requires -- and that the fixture discriminates on -- is
that `activeSites` (the function implementing that policy) is EXPOSED through
module.exports so it can be unit-tested. This refimpl adds exactly that export,
leaving every other line untouched. Idempotent: a no-op if already applied.
"""
import pathlib
import sys

wt = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
p = wt / 'sidecar/src/loginQueue.js'
t = p.read_text()

OLD = "module.exports = { sitesNeedingLogin, runQueueOnce };"
NEW = "module.exports = { sitesNeedingLogin, runQueueOnce, activeSites };"

if NEW in t:
    print("refimpl already applied (activeSites exported)")
    sys.exit(0)

assert OLD in t, "refimpl anchor not found -- did the target change?"
p.write_text(t.replace(OLD, NEW, 1))
print("refimpl applied")
