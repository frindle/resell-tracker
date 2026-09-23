# TASK: rt-bfmr-mytrackerid-preserve

## Confirmed defect (observed, not suspected)

CONFIRMED. Live symptom (2026-09-23): the resell-tracker BFMR Reservations UI
showed, on an attempted tracking-number push, "Link saved, but the order
number was NOT pushed to BFMR: reservation has no myTrackerId -- sync
reservations from BFMR first" -- immediately after a sync had already run
("Synced 767"). Verified by reading app/api/bfmr/sync-reservations/route.ts:
the upsert's UPDATE branch (not CREATE) unconditionally sets
`myTrackerId: item.my_tracker_id ? Number(item.my_tracker_id) : null`. BFMR's
REST `/my-tracker` payload routinely omits `my_tracker_id` for a row whose
myTrackerId was set moments earlier via this same file's separate Web-App
backfill scrape (see `webBackfillAttemptedAt` further down). So the very next
REST sync silently nulls out a value that was just correctly written, and the
UI's myTrackerId-required check then (correctly) refuses to push tracking --
misreporting "sync reservations from BFMR first" when a sync DID happen and
in fact caused the loss.

## Entry point

app/api/bfmr/sync-reservations/route.ts:156 -- the `myTrackerId:` field inside
the reservation upsert's UPDATE branch (the CREATE branch a few lines above,
~108, is a different occurrence of the same expression and must NOT be
touched).

## Required change

In the reservation upsert's UPDATE branch (not the CREATE branch) in app/api/bfmr/sync-reservations/route.ts, myTrackerId must be preserved (NOT overwritten with null) when BFMR's REST tracker item omits my_tracker_id. Currently 'myTrackerId: item.my_tracker_id ? Number(item.my_tracker_id) : null' unconditionally nulls out a value the Web-App-surface backfill (further down in this same file, look for webBackfillAttemptedAt) previously wrote for that row, whenever a later REST sync's item lacks my_tracker_id -- which is the routine case REST omits it. The fix: on the update branch only, when item.my_tracker_id is falsy, DO NOT include myTrackerId in the update payload at all (Prisma: omit the key so it's untouched) rather than setting it to null. When item.my_tracker_id IS present, set it to Number(item.my_tracker_id) as today (a real REST-provided value should still win and overwrite). The CREATE branch is unaffected and must keep setting null when absent (no prior row to preserve).

Implement this specifically as a conditional spread on the update object
literal: replace the `myTrackerId: item.my_tracker_id ? Number(item.my_tracker_id) : null`
line in the UPDATE branch with a spread that includes the key only when
truthy, e.g. `...(item.my_tracker_id ? { myTrackerId: Number(item.my_tracker_id) } : {})`.
This is the literal pinned below -- use this exact shape (whitespace may
differ) rather than an `if`/`delete` pattern, so the gate can verify it
mechanically.

Behaviour that must NOT change:
- The CREATE branch (~line 108) keeps setting myTrackerId to null when
  item.my_tracker_id is absent -- there is no prior row to preserve there.
- When item.my_tracker_id IS present in the REST payload, the UPDATE branch
  still overwrites myTrackerId with Number(item.my_tracker_id) -- a real
  REST-provided value still wins.
- No other upsert field (itemId, dealId, status, etc.) changes shape or
  ordering in either branch.

## Must contain

- `...(item.my_tracker_id ? { myTrackerId: Number(item.my_tracker_id) } : {})`

(The gate holds the reference impl against this list. If the verify goes green
while one of these is absent from the changed files, the verify does not
enforce the spec -- that is a benign verify, caught mechanically.)

(A bare bullet checks the default target. To PIN a literal to a specific file --
useful when a fix spans a helper file and the route/wiring that calls it --
prefix the bullet with `in <path>:`, e.g.
`- in app/api/x/route.ts: ` followed by a backtick-quoted token. Then that
token is required in THAT file, not the target.)

## Scope

Only edit `app/api/bfmr/sync-reservations/route.ts`; do not edit `verify.sh`, `verify.test.ts` or `TASK.md`.
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
