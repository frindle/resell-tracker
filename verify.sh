#!/usr/bin/env bash
# GATE for the BG-credited-per-shipment fix. Asserts the PROPERTY, not a proxy.
set -euo pipefail
cd "$(dirname "$0")"

# (1) The decision must be a pure ALL-shipments function that behaves correctly
#     on the adversarial cases (this is what actually catches the 899 bug).
node --experimental-strip-types --test verify.bgCredited.test.ts

# (2) The fix must be WIRED into the real setter, not left as dead code:
#     lib/bgSync.ts (where bgCredited is decided during BG receipt sync) must
#     use the pure function. A green (1) with no wiring would still ship the bug.
grep -q 'isOrderFullyCredited' lib/bgSync.ts

# (3) The edited sync file must still strip-and-parse (the repo suite runs on
#     node --experimental-strip-types; there is no global tsc gate).
node --experimental-strip-types --check lib/bgSync.ts

echo "VERIFY_OK"
