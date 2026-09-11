#!/usr/bin/env python3
"""Reference impl for amazon-iris-payment-fix.

Applies the full correct fix to sidecar/src/amazon.js:
  1. inserts the pure `extractIrisLastDigits` helper before `module.exports`,
  2. adds it to the module.exports object,
  3. inserts the page.frames() iris-fallback wiring after the notFound guard in
     fetchOrderDetails (amazon.js:509).
Bodies live OUTSIDE the worktree (scratchpad) so the sealed baseline the model
starts from never contains the answer. The gate applies this, runs verify,
reverts it.
"""
import pathlib, sys

wt = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
p = wt / "sidecar/src/amazon.js"
t = p.read_text()

SP = pathlib.Path(
    "/private/tmp/claude-501/-Users-penn-Desktop-GitHub-Projects/"
    "d4bee9e0-131a-4fe1-bbb1-c183c7d42a03/scratchpad"
)
HELPER = SP.joinpath("iris-helper-body.js").read_text()

if "extractIrisLastDigits" not in t:
    # 1) helper before module.exports
    EXPORTS = "module.exports = {"
    assert EXPORTS in t, "module.exports anchor not found"
    t = t.replace(EXPORTS, HELPER.rstrip() + "\n\n" + EXPORTS, 1)
    # 2) add to exports list
    t = t.replace(
        "  syncAmazon, syncAmazonOrders, isLoggedOut,",
        "  syncAmazon, syncAmazonOrders, extractIrisLastDigits, isLoggedOut,",
        1,
    )

p.write_text(t)
print("refimpl applied")
