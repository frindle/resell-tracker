#!/usr/bin/env python3
"""Reference impl for: bfmr-cap-link-to-reservation.

Adds `capLinkToReservation` (the pure cap helper) to lib/bfmrAutoLink.ts plus
its `expectedLinkValue` import. The gate applies this, runs verify, reverts it:
proves the task is satisfiable and that the verify enforces the spec.

The function BODY lives OUTSIDE the worktree (scratchpad) so the sealed baseline
the model starts from never contains the answer.
"""
import pathlib
import sys

wt = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
p = wt / 'lib/bfmrAutoLink.ts'
t = p.read_text()

BODY = pathlib.Path(
    "/private/tmp/claude-501/-Users-penn-Desktop-GitHub-Projects/"
    "d4bee9e0-131a-4fe1-bbb1-c183c7d42a03/scratchpad/bfmr-cap-refimpl-body.ts"
).read_text()

IMPORT = "import { expectedLinkValue } from '@/lib/bfmrLinkValue';\n"
ANCHOR = "import { recalcBfmrSalePrice } from '@/lib/bfmrSalePrice';\n"

if "expectedLinkValue" not in t:
    assert ANCHOR in t, "import anchor not found -- did the target's imports change?"
    t = t.replace(ANCHOR, ANCHOR + IMPORT, 1)

if "capLinkToReservation" not in t:
    t = t.rstrip() + "\n" + BODY

p.write_text(t)
print("refimpl applied")
