# TASK: bfmrJoin

## Confirmed defect (observed, not suspected)

Submitting BFMR tracking for order 930 returns **409** right now, live. The 409
is thrown at `app/api/bfmr/submit-reservation-tracking/route.ts:82-86`, a guard
on `reservation.myTrackerId == null`. Order 930 (qty 5) and its sibling order
931 (qty 3) are the two halves of ONE 8-unit BFMR commitment, and both have
`myTrackerId = null` permanently.

Verified by tracing every write to the column:
- The REST upsert (`sync-reservations/route.ts:135,155`) sets `myTrackerId` from
  `item.my_tracker_id`, which is ALWAYS null -- `lib/bfmrWeb.ts:542-543` states
  the REST surface "never returns RID/PID/my_tracker_id at all."
- The stale-id retry (`submit-reservation-tracking/route.ts:160`) only re-points
  an already-non-null id; the line-82 guard returns before it can bootstrap.
- So the Web backfill in `sync-reservations/route.ts` is the SOLE path, and its
  gate (line 287) sets `myTrackerId` only when exactly one Web row matches.

The match key is `bfmrJoinKey` (`lib/bfmrJoin.ts:84-97`) =
`reserved_at|item|qty|order_id`, with **both qty and order_id load-bearing**. A
split commitment is ONE BFMR Web row whose qty is divided across >1 local
reservation rows, each carrying its own PARTIAL qty and its OWN order id. Each
half therefore matches the single Web row on neither field -> zero matches ->
`webUnmatched` -> `myTrackerId` stays null forever.

Re-running sync cannot fix it: the retry window
(`sync-reservations/route.ts:209-216`) only re-stamps a timestamp and re-runs the
identical failing match, so it never converges. That is why the documented
remedy ("sync reservations from BFMR first") is ineffective for exactly this case.

1:1 orders are unaffected: qty and order_id both equal the Web row's, so there is
exactly one match and the submit succeeds.

## Entry point

`lib/bfmrJoin.ts:97` -- immediately after `bfmrJoinKey`, which ends at line 97.

## Required change

Add a pure, exported function to `lib/bfmrJoin.ts` that resolves a split
commitment to its single Web row by SUMMING the split halves' quantities:

```ts
export function matchSplitGroups(
  locals: Array<{ id: number; reserved_at?: unknown; item_model_number?: unknown;
                  item_name?: unknown; qty?: unknown }>,
  webRows: Array<{ reserved_at?: unknown; item_model_number?: unknown;
                   item_name?: unknown; qty?: unknown; my_tracker_id?: unknown }>,
): Array<{ id: number; my_tracker_id: number }>
```

Required behaviour:

1. Group BOTH sides on a key that drops qty AND order_id, keeping only the two
   fields a split cannot change: the normalized `reserved_at` and the item
   (`item_model_number` falling back to `item_name`, trimmed + lowercased --
   exactly as `bfmrJoinKey` already derives `item`). Reuse
   `normalizeBfmrTimestamp` so the REST "08/25/2026 12:05:05" and Web
   "2026-08-25 12:05:05" spellings of the same instant still group together.
2. Consider only groups of **>= 2** local rows. A group of one is the ordinary
   1:1 case and is already handled by the existing per-row path -- this function
   must return nothing for it, so the two paths can never both claim a row.
3. Sum the local `qty` values in the group. Find the Web rows in the SAME group
   whose own qty equals that sum and that have a truthy `my_tracker_id`.
4. If **exactly one** such Web row exists, emit `{ id, my_tracker_id }` for
   EVERY local row in that group -- `my_tracker_id` as a Number.
5. If **zero or more than one** match, emit NOTHING for that group. A split whose
   summed qty matches no Web row, or matches two, stays unresolved and keeps
   `myTrackerId` null. Guessing here is the wrong-reservation bug this file's own
   header says the codebase already paid for once -- do not pick one.
6. Never throw on degenerate input: missing/null/non-numeric `qty`, absent
   `reserved_at` or item fields, empty arrays.

`order_id` deliberately plays NO part in this grouping -- it is precisely the
field that legitimately varies between halves of one split, which is why the
exact-match key cannot resolve them.

Behaviour that must NOT change:
- `bfmrJoinKey` keeps its exact current signature and output, including both
  `qty` and `order_id` in the key. The 1:1 path depends on it and it must stay
  byte-identical; this task ADDS a second path, it does not loosen the first.
- `normalizeBfmrTimestamp` is unchanged.
- `buildOrderIdTrackerRow` is unchanged.
- A group whose summed qty does not match any Web row still resolves to nothing
  (the `webUnmatched` outcome), and an ambiguous group still resolves to nothing
  (the `webAmbiguous` outcome). Neither may start guessing.
- The module stays import-free: no DB, no fetch, no session cache. Its header
  says this on purpose -- it has to stay exercisable against a captured pair of
  live rows.

## Must contain

- `matchSplitGroups`
- `normalizeBfmrTimestamp`

(The gate holds the reference impl against this list. If the verify goes green
while one of these is absent from the changed files, the verify does not
enforce the spec -- that is a benign verify, caught mechanically.)

## Scope

Only edit `lib/bfmrJoin.ts`; do not edit `verify.sh`, `verify.test.ts` or `TASK.md`.
verify.test.ts is the test fixture -- changing it invalidates the check.

## Keep every changed line exercised (relevance)

After the job runs, a mutation check flips/deletes each line you changed and
asks the verify to catch it. A changed line whose every mutant survives --
because no test asserts it -- FAILS the gate even when the fix is correct, and
the review never runs. So do NOT emit an isolated, untested line:
- Fold an unavoidable constant onto a line the test already exercises. Put a
  `timeout=` / a `daemon=True` flag / a small tuning number on the SAME line as
  a header dict, URL, or argument the fixture checks -- never on its own line.
- Prefer falling through to an implicit `return None` over a standalone
  `return None` in an `except:` the tests do not assert.
- If a line genuinely cannot be asserted and cannot be folded, it usually
  should not be a separate line at all -- restructure so it isn't.
This is not about adding bogus assertions for constants; it is about not
leaving a lone line that carries no tested behaviour.

## Loop instruction

Run `bash verify.sh` after every edit and keep editing until it prints
`VERIFY_OK`.
