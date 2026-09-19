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
r = r.replace(imp, imp + "\nimport { resolveTrackerBackfill } from '@/lib/bfmrJoin';", 1)

start = "        const now = new Date();\n"
end = "        }\n        // Chunked batch transactions:"
i = r.index(start)
j = r.index(end) + len("        }\n")
assert i < j, "loop anchors out of order"

r = r[:i] + '''        const now = new Date();
        // raw is the REST item verbatim and is the only place reserved_at and
        // item_model_number survive -- neither is a column. Fall back to the
        // columns we do have if raw is missing or unparseable, which yields a
        // key that simply won't match rather than a wrong one.
        const normalizedLocals = needsWebBackfill.map(r => {
          let rawItem: Record<string, unknown> = {};
          if (r.raw) {
            try { rawItem = JSON.parse(r.raw) as Record<string, unknown>; } catch { rawItem = {}; }
          }
          return {
            id: r.id,
            reserved_at: rawItem.reserved_at,
            item_model_number: rawItem.item_model_number,
            item_name: rawItem.item_name ?? r.itemName,
            qty: r.qty,
            order_id: r.bfmrOrderId,
          };
        });
        for (const l of normalizedLocals.slice(0, 5)) localKeySamples.push(bfmrJoinKey(l));
        // Both passes live here now: the exact 1:1 key AND the split-commitment
        // fallback. matchSplitGroups was correct and UNREFERENCED, which is why
        // every split half 409'd on submit.
        const resolution = resolveTrackerBackfill(normalizedLocals, webRows);
        const matchedUpdates = resolution.matched.map(m => ({ id: m.id, myTrackerId: m.my_tracker_id }));
        // Stamp EVERY row attempted this pass -- matched, ambiguous AND
        // unmatched alike -- or the retry set never empties and the ~90s
        // scrape runs on every sync again.
        const stampIds = [...resolution.ambiguous, ...resolution.unmatched];
        webBackfilled = resolution.matched.length;
        webAmbiguous = resolution.ambiguous.length;
        webUnmatched = resolution.unmatched.length;
''' + r[j:]

route.write_text(r)
print("refimpl applied")
