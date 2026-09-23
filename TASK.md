# TASK: rt-bfmr-pending-sync-scope-s1-the-exact-13-value-enum

## Confirmed defect (observed, not suspected)

The 13-value BFMR tracker status list is hard-coded as a comma-joined string in
`app/api/bfmr/sync-reservations/route.ts` (line 45: `status: 'purchased,reserved,return,payment_error,shipped,processed,set_aside,paid,cancelled,returned,closed,deadline,pkg_received'`) while the sync-scope module `lib/bfmrSyncScope.ts` has no shared constant for it. Verified by reading both files in this worktree: the route's single TrackerFilter carries the full catalogue list inline, and `grep -n "BFMR_ALL_TRACKER_STATUSES" lib/ app/` returns nothing -- there is no module-level source of truth, so a future 'all'-scope plan (s3, resolveBfmrSyncPlan) built from a separate copy can silently drift from the route's full-catalogue pass.

## Entry point

lib/bfmrSyncScope.ts:1 (top of file; add the new exports alongside the existing `BfmrSyncScope` / `parseBfmrSyncScope` work, which must be preserved)

## Required change

In lib/bfmrSyncScope.ts: export const BFMR_ALL_TRACKER_STATUSES = ['purchased', 'reserved', 'return', 'payment_error', 'shipped', 'processed', 'set_aside', 'paid', 'cancelled', 'returned', 'closed', 'deadline', 'pkg_received'] as const; -- the exact 13-value BFMR tracker status enum that app/api/bfmr/sync-reservations/route.ts pages over today (its single TrackerFilter `status: 'purchased,reserved,return,payment_error,shipped,processed,set_aside,paid,cancelled,returned,closed,deadline,pkg_received'`), UNCHANGED and in THIS order. Also export type BfmrTrackerStatus = (typeof BFMR_ALL_TRACKER_STATUSES)[number]. Pure data: no imports, no functions, no DB/network/clock. The 'all' sync scope (s3, resolveBfmrSyncPlan) resolves to ONE filter { status: BFMR_ALL_TRACKER_STATUSES.join(','), page_size: 200 } built from this constant, so the route's full-catalogue pass and the module can never drift apart.

Behaviour that must NOT change:
- `parseBfmrSyncScope('all')` returns `'all'`, `parseBfmrSyncScope('pending')` returns `'pending'`; any other input (including `undefined`) falls back to `'all'`. Never throws.
- The existing `export type BfmrSyncScope = 'all' | 'pending';` stays exported and unchanged.
- No new imports are added to the file; it remains dependency-free pure data + the one existing function.

## Must contain

- `BFMR_ALL_TRACKER_STATUSES = ['purchased', 'reserved', 'return', 'payment_error', 'shipped', 'processed', 'set_aside', 'paid', 'cancelled', 'returned', 'closed', 'deadline', 'pkg_received'] as const;`
- `export type BfmrTrackerStatus = (typeof BFMR_ALL_TRACKER_STATUSES)[number];`

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
