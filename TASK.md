# TASK: rt-bfmr-pending-sync-scope-s3-export-function-resolveb

## Confirmed defect (observed, not suspected)

`lib/bfmrSyncScope.ts` exports the scope type and `parseBfmrSyncScope`, but has
NO function that turns a parsed scope into an executable sync plan. The
sync-reservations route (`app/api/bfmr/sync-reservations/route.ts`) currently
hard-codes its own filter list inline, so there is no single source of truth for
"what does each scope actually run". Verified by reading the file: it contains
only `BfmrSyncScope`, `BFMR_ALL_TRACKER_STATUSES`, `BfmrTrackerStatus`, and
`parseBfmrSyncScope` -- no plan resolver exists, so callers cannot ask "given a
scope, which filters and which runs?".

## Entry point

lib/bfmrSyncScope.ts:26 (end of file -- append the new export after `parseBfmrSyncScope`)

## Required change

In lib/bfmrSyncScope.ts: export function resolveBfmrSyncPlan(scope: BfmrSyncScope): { filters: BfmrTrackerFilter[]; runWebBackfill: boolean; runStaleLinkScan: boolean; runAutoLink: boolean }. CORRECTED: the resolved filter for the narrow/unlinked scope must use quick_filter: 'action_needed' (not 'pending') -- see root intent for evidence. The 'all' scope's single filter must be { status: BFMR_ALL_TRACKER_STATUSES.join(','), page_size: 200 } (the s1 constant), never a re-typed literal.

Contract, exactly:
- `BfmrTrackerFilter` is the /my-tracker filter shape -- alias it from lib/bfmr.ts (`import type { TrackerFilter } from './bfmr'; export type BfmrTrackerFilter = TrackerFilter;`). Do not re-declare its fields locally.
- scope `'all'`: `{ filters: [ { status: BFMR_ALL_TRACKER_STATUSES.join(','), page_size: 200 } ], runWebBackfill: true, runStaleLinkScan: true, runAutoLink: true }`. The `status` value MUST be built from the existing `BFMR_ALL_TRACKER_STATUSES` constant via `.join(',')` -- never a re-typed status string. No `quick_filter` key on this filter.
- scope `'pending'` (the narrow/unlinked scope): `{ filters: [ { quick_filter: 'action_needed', page_size: 200 } ], runWebBackfill: false, runStaleLinkScan: false, runAutoLink: true }`. `quick_filter` is exactly the string `'action_needed'`, NOT `'pending'`; no `status` key.
- Pure function: no I/O, no throws; input is already a valid `BfmrSyncScope`.

Behaviour that must NOT change:
- `parseBfmrSyncScope` keeps its exact current behaviour (strict equality on 'all'/'pending', fallback to 'all', never throws).
- `BFMR_ALL_TRACKER_STATUSES` stays the same 13 values in the same order.
- The existing exports (`BfmrSyncScope`, `BfmrTrackerStatus`) are untouched.

## Must contain

- `export function resolveBfmrSyncPlan(scope: BfmrSyncScope)`
- `runWebBackfill`
- `runStaleLinkScan`
- `runAutoLink`
- `quick_filter: 'action_needed'`
- `BFMR_ALL_TRACKER_STATUSES.join(',')`
- `page_size: 200`

(The gate holds the reference impl against this list. If the verify goes green
while one of these is absent from the changed files, the verify does not
enforce the spec -- that is a benign verify, caught mechanically.)

## Scope

Only edit `lib/bfmrSyncScope.ts`; do not edit `verify.sh`, `verify.test.ts` or `TASK.md`.
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
