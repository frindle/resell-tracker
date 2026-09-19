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

### 1. `lib/bfmrJoin.ts` -- add TWO new exported pure functions

Both go in this file, NOT in the route, because the route cannot be driven in a
test without standing up Prisma and a headless BFMR login. Everything that can
be a pure decision must be one.

```
export function normalizeBackfillLocal(row): { id, reserved_at, item_model_number, item_name, qty, order_id }

export function resolveTrackerBackfill(locals, webRows): {
  matchedUpdates: Array<{ id: number; myTrackerId: number }>;
  stampIds: number[];
  counts: { backfilled: number; ambiguous: number; unmatched: number };
}
```

**`normalizeBackfillLocal(row)`** takes one BfmrReservation row
(`{ id, raw, itemName, qty, bfmrOrderId }`) and reshapes it into the
`bfmrJoinKey` field shape. `reserved_at` and `item_model_number` live ONLY
inside the JSON string in `row.raw` -- neither is a column. Parse `row.raw`
inside a try/catch and fall back to `{}` on failure (and when `raw` is null or
empty), so a bad blob yields a key that simply will not match rather than a
WRONG one. `item_name` is `rawItem.item_name ?? row.itemName`; `qty` is
`row.qty`; `order_id` is `row.bfmrOrderId`.

**`resolveTrackerBackfill(locals, webRows)`** must do exactly this:

1. **1:1 pass.** Index `webRows` by `bfmrJoinKey`. For each local, look up its
   own `bfmrJoinKey`:
   - exactly one web row AND that row has a usable `my_tracker_id` (a finite
     number greater than zero) -> `matchedUpdates`, as
     `{ id, myTrackerId }` (camelCase -- it is written straight to Prisma)
   - more than one web row -> ambiguous, and it is DONE (see step 2)
   - otherwise -> it is a leftover, carried into step 2
2. **Split pass.** Call the EXISTING `matchSplitGroups(leftovers, webRows)` --
   the leftovers ONLY, never the ambiguous rows and never the already-matched
   rows. Every `{id, my_tracker_id}` it returns joins `matchedUpdates`.
3. Whatever is still left over is unmatched.
4. `stampIds` is the ambiguous ids followed by the unmatched ids -- every row
   attempted this pass that did NOT resolve. `counts` carries the three
   tallies: `backfilled` (= `matchedUpdates.length`), `ambiguous`, `unmatched`.

No id may appear in both `matchedUpdates` and `stampIds`. Do not reimplement
`matchSplitGroups`, and do not change it, `bfmrJoinKey`, `bfmrSplitGroupKey`,
or `normalizeBfmrTimestamp`.

### 2. `app/api/bfmr/sync-reservations/route.ts` -- call them

Replace the whole inline classification block (the `const matchedUpdates` /
`const stampIds` declarations and the `for (const r of needsWebBackfill)` loop
that follows them) with a mechanical substitution. Nothing else in the file
changes:

- Import `normalizeBackfillLocal` and `resolveTrackerBackfill` from
  `@/lib/bfmrJoin`.
- `const normalizedLocals = needsWebBackfill.map(normalizeBackfillLocal);`
- Keep the `localKeySamples` diagnostic, now fed from `normalizedLocals`
  (still capped at 5) via `bfmrJoinKey`.
- The inline `const byKey = new Map<...>()` index above is now DEAD -- the
  resolver owns the join. Delete it, keeping only the `webKeySamples`
  diagnostic it used to feed (first 5 web rows, via `bfmrJoinKey`). Leaving
  a second, unused join index in the route is how this bug looked in the
  first place.
- `const { matchedUpdates, stampIds, counts } = resolveTrackerBackfill(normalizedLocals, webRows);`
- Assign the three existing counters from `counts`: `webBackfilled`,
  `webAmbiguous`, `webUnmatched`.

The `const now = new Date();` line, the two chunked `prisma.$transaction`
write loops below, and the surrounding try/catch all stay exactly as they are
and keep consuming `matchedUpdates` / `stampIds` under those same names.

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

- in lib/bfmrJoin.ts: `resolveTrackerBackfill`
- in lib/bfmrJoin.ts: `normalizeBackfillLocal`
- in lib/bfmrJoin.ts: `matchSplitGroups(`
- in app/api/bfmr/sync-reservations/route.ts: `resolveTrackerBackfill`
- in app/api/bfmr/sync-reservations/route.ts: `normalizeBackfillLocal`

(The gate holds the reference impl against this list. The route bullets are the
load-bearing ones: this entire defect is a correct helper that nothing called,
so a fix which adds a second correct-but-unreferenced helper reproduces the bug
exactly. The route MUST call it.)

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
