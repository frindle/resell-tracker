#!/usr/bin/env python3
"""Reference impl for: bfmr-overcount. Copies the finished bfmrLinkReconcile.ts
(kept in scratchpad, outside the worktree, so refimpl-reverted removes it) into
the target."""
import pathlib, sys, shutil
wt = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
target = wt / 'lib/bfmrLinkReconcile.ts'
body = pathlib.Path("/private/tmp/claude-501/-Users-penn-Desktop-GitHub-Projects/d4bee9e0-131a-4fe1-bbb1-c183c7d42a03/scratchpad/bfmr_link_reconcile_refimpl.ts")
assert body.exists(), f"refimpl body missing: {body}"
shutil.copyfile(body, target)
print("refimpl applied")
