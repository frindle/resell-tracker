# TASK: bfmr-split-wiring

## Confirmed defect (observed, not suspected)

CONFIRMED LIVE. `POST /api/bfmr/submit-reservation-tracking` returns 409 for
split-commitment reservations, because their `myTrackerId` is null and never
becomes non-null. The throw is at
`app/api/bfmr/submit-reservation-tracking/route.ts:82-86`.

Root cause, verified by reading the code: `matchSplitGroups()` was written to
resolve exactly these rows and landed in commit `bf4ca57` in `lib/bfmrJoin.ts`
-- and **nothing calls it**. `grep -rn matchSplitGroups app/` returns zero
hits. The web-backfill loop in the sync route runs only the 1:1 `bfmrJoinKey`
pass, so both halves of a split commitment fall into the `webUnmatched` bucket
on every sync, forever.

Why the 1:1 pass structurally cannot match them: a BFMR commitment split across
two local reservation rows is ONE web row (one `my_tracker_id`) whose quantity
was divided. Each half carries a partial `qty` and its own `order_id`, and
`bfmrJoinKey` includes BOTH of those fields -- deliberately, for the 1:1 case.
So neither half's key can ever equal the web row's key.

## Entry point

`app/api/bfmr/sync-reservations/route.ts:265` -- the `for (const r of
needsWebBackfill)` loop that classifies each local row into matched /
ambiguous / unmatched. That whole classification moves into the new function.

## Required change

**Two edits, in this order.**

### 1. `lib/bfmrJoin.ts` -- add ONE new exported pure function

```
export function resolveTrackerBackfill(locals, webRows): {
  matched: Array<{ id: number; my_tracker_id: number }>;
  ambiguous: number[];
  unmatched: number[];
}
```

`locals` are objects with `id` plus the `bfmrJoinKey` fields
(`reserved_at`, `item_model_number`, `item_name`, `qty`, `order_id`).
`webRows` are the Web App rows, which additionally carry `my_tracker_id`.

It must do exactly this:

1. **1:1 pass.** Index `webRows` by `bfmrJoinKey`. For each local, look up its
   own `bfmrJoinKey`:
   - exactly one web row AND that row has a usable `my_tracker_id` -> `matched`
   - more than one web row -> `ambiguous` (and it is DONE -- see step 2)
   - otherwise -> it is a leftover, carried into step 2
2. **Split pass.** Call the EXISTING `matchSplitGroups(leftovers, webRows)` --
   the leftovers ONLY, never the ambiguous rows and never the already-matched
   rows. Every `{id, my_tracker_id}` it returns joins `matched`.
3. Whatever is still left over is `unmatched`.

No id may appear in two buckets. Do not reimplement `matchSplitGroups`, and do
not change it, `bfmrJoinKey`, `bfmrSplitGroupKey`, or `normalizeBfmrTimestamp`.

### 2. `app/api/bfmr/sync-reservations/route.ts` -- call it

Replace the inline classification loop with a single call:

- Build the normalized local array first. `reserved_at` and
  `item_model_number` live ONLY inside the JSON `r.raw` column, so keep the
  existing `JSON.parse(r.raw)` fallback logic verbatim -- on a parse failure
  fall back to `{}`, which yields a key that simply will not match rather than
  a wrong one. Keep `item_name: rawItem.item_name ?? r.itemName`,
  `qty: r.qty`, `order_id: r.bfmrOrderId`.
- Import `resolveTrackerBackfill` from `@/lib/bfmrJoin` and call it once.
- Map its result onto the EXISTING variables, changing nothing else:
  `matchedUpdates` from `matched` (as `{ id, myTrackerId }`), `stampIds` from
  `ambiguous` concatenated with `unmatched`, and the three counters
  `webBackfilled` / `webAmbiguous` / `webUnmatched` from the three array
  lengths.

Behaviour that must NOT change:
- A row that resolves to exactly one web row on the 1:1 key still resolves the
  same way, to the same tracker id.
- Ambiguity still resolves to NOTHING. Zero or more than one candidate leaves
  `myTrackerId` null. Guessing a reservation is the bug this module already
  paid for once -- "loudly wrong, not silently wrong".
- EVERY row attempted this pass still gets `webBackfillAttemptedAt` stamped --
  matched, ambiguous and unmatched alike -- or the retry set never empties and
  the ~90s headless scrape runs on every sync again.
- The chunked `prisma.$transaction` batching (`UPDATE_CHUNK = 100`) and the
  surrounding try/catch that keeps a Web-surface outage non-fatal stay exactly
  as they are.
- The REST sync above this block is untouched.

## Must contain

- in `lib/bfmrJoin.ts`: `resolveTrackerBackfill`
- in `lib/bfmrJoin.ts`: `matchSplitGroups(`
- in `app/api/bfmr/sync-reservations/route.ts`: `resolveTrackerBackfill`

(The gate holds the reference impl against this list. The third bullet is the
load-bearing one: this entire defect is a correct helper that nothing called,
so a fix which adds a second correct-but-unreferenced helper reproduces the
bug exactly. The route MUST call it.)

## Scope

Only edit `lib/bfmrJoin.ts`, `app/api/bfmr/sync-reservations/route.ts`; do not
edit `verify.sh`, `lib/bfmrSplitWiring.test.ts` or `TASK.md`.
`lib/bfmrSplitWiring.test.ts` is the test fixture -- changing it invalidates
the check.

## Keep every changed line exercised (relevance)

After the job runs, a mutation check flips/deletes each line you changed and
asks the verify to catch it. A changed line whose every mutant survives --
because no test asserts it -- FAILS the gate even when the fix is correct, and
the review never runs. So do NOT emit an isolated, untested line:
- Fold an unavoidable constant onto a line the test already exercises.
- If a line genuinely cannot be asserted and cannot be folded, it usually
  should not be a separate line at all -- restructure so it isn't.
This is not about adding bogus assertions for constants; it is about not
leaving a lone line that carries no tested behaviour.

## Loop instruction

Run `bash verify.sh` after every edit and fix the named FAILs until it prints
`VERIFY_OK`.
