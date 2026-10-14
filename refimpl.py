#!/usr/bin/env python3
"""Reference impl for: egiftRedemption. Body lives OUTSIDE the worktree (scratchpad) so the
model never starts from the answer; the gate applies it, runs verify, reverts it."""
import pathlib, sys
wt = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
body = pathlib.Path("/private/tmp/claude-501/-Users-penn-Desktop-GitHub-Projects/4a511821-f447-4cf7-b6c5-cb4b844ac738/scratchpad/egift/redemption_body.js").read_text()
(wt / "sidecar/src/costcoEgiftRedemption.js").write_text(body)
print("refimpl applied")
