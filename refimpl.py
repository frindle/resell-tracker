#!/usr/bin/env python3
"""Reference impl for bfmr-split-wiring.

Body lives OUTSIDE the worktree on purpose: anything written inside is
untracked, so `refimpl-reverted` would not remove it and the model would start
from the answer.
"""
import sys
from pathlib import Path

WT = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parent)
BODY = Path("/private/tmp/claude-501/-Users-penn-Desktop-GitHub-Projects/"
            "c2db8aba-e860-4a9a-afce-d25639864720/scratchpad/bfmr_refimpl_body.ts")

# --- 1. the pure helper -----------------------------------------------------
join = WT / "lib" / "bfmrJoin.ts"
src = join.read_text()
assert "resolveTrackerBackfill" not in src, "already applied"
join.write_text(src.rstrip("\n") + "\n" + BODY.read_text())

# --- 2. the wiring ----------------------------------------------------------
route = WT / "app" / "api" / "bfmr" / "sync-reservations" / "route.ts"
r = route.read_text()

imp = "import { getWebTrackerRows, bfmrJoinKey, WEB_BACKFILL_FETCH } from '@/lib/bfmrWeb';"
assert imp in r, "import anchor moved"
r = r.replace(
    imp,
    imp + "\nimport { normalizeBackfillLocal, resolveTrackerBackfill } from '@/lib/bfmrJoin';",
    1,
)

# The inline web-row index is dead once the resolver owns the join: only the
# 5-key diagnostic sample still needs it.
idx = """        const byKey = new Map<string, typeof webRows>();
        for (const row of webRows) {
          const key = bfmrJoinKey(row);
          if (webKeySamples.length < 5) webKeySamples.push(key);
          const arr = byKey.get(key) ?? [];
          arr.push(row);
          byKey.set(key, arr);
        }
"""
assert idx in r, "byKey index anchor moved"
r = r.replace(
    idx,
    "        for (const row of webRows.slice(0, 5)) webKeySamples.push(bfmrJoinKey(row));\n",
    1,
)

start = "        const now = new Date();\n"
end = "        }\n        // Chunked batch transactions:"
i = r.index(start)
j = r.index(end) + len("        }\n")
assert i < j, "loop anchors out of order"

r = r[:i] + '''        const now = new Date();
        // The whole backfill decision -- raw-blob normalization, the exact 1:1
        // key, AND the split-commitment fallback -- lives in lib/bfmrJoin.ts so
        // it is testable without Prisma. matchSplitGroups was correct and
        // UNREFERENCED, which is why every split half 409'd on submit.
        const normalizedLocals = needsWebBackfill.map(normalizeBackfillLocal);
        for (const l of normalizedLocals.slice(0, 5)) localKeySamples.push(bfmrJoinKey(l));
        const { matchedUpdates, stampIds, counts } = resolveTrackerBackfill(normalizedLocals, webRows);
        webBackfilled = counts.backfilled;
        webAmbiguous = counts.ambiguous;
        webUnmatched = counts.unmatched;
''' + r[j:]

route.write_text(r)
print("refimpl applied")
