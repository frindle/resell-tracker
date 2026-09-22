# TASK: rt-cc-waitlist-core-s1-export-function-decidewa

## Confirmed defect (observed, not suspected)

`lib/ccWaitlist.ts` is a placeholder stub (`export {};`) -- it exports no
decision function at all. Verified by reading the file and by importing it in
a scratch script: `import { decideWaitlist } from './lib/ccWaitlist'` throws
"does not provide an export named 'decideWaitlist'". The waitlist core has no
admission decision to build on yet; this slice creates it.

## Entry point

`app/api/bfmr/sync-reservations/route.ts:265` -- the `for (const r of
needsWebBackfill)` loop that classifies each local row into matched /
ambiguous / unmatched. That whole classification moves into the new function.

## Required change

In lib/ccWaitlist.ts, add the pure admission-decision function and its types:

- `export interface WaitlistCard { email: string; createdAt: string }` where
  `createdAt` is an ISO date (`YYYY-MM-DD`).
- `export type WaitlistDecision = { action: 'admit' | 'reject'; reason: string }`.
- `export function decideWaitlist(card: WaitlistCard, currentRate: number, today: string): WaitlistDecision`

Exact contract (pure function -- no I/O, no clock reads; `today` is passed in):

1. If `currentRate <= 0`, return `{ action: 'reject', reason }` with a
   non-empty `reason`. A zero or negative rate never admits.
2. Else if `card.createdAt >= today` (created on or after `today`, compared as
   ISO date strings), return `{ action: 'reject', reason }` with a non-empty
   `reason`. Only cards created strictly before `today` are eligible.
3. Otherwise return `{ action: 'admit', reason }` where the `reason` is a
   non-empty string that mentions both `card.createdAt` and `today`.

The decision object has exactly two fields, `action` and `reason` -- no extra
fields. The function must not throw for any of these inputs.

Behaviour that must NOT change:
- Nothing else exists in this file yet; the stub's `export {};` may be removed
  as part of replacing it with the real module. No other file is touched, so
  nothing outside `lib/ccWaitlist.ts` can regress.

## Must contain

- `export function decideWaitlist(card: WaitlistCard, currentRate: number, today: string): WaitlistDecision`
- `export interface WaitlistCard`
- `export type WaitlistDecision`
- `'admit'`
- `'reject'`

(The gate holds the reference impl against this list. If the verify goes green
while one of these is absent from the changed files, the verify does not
enforce the spec -- that is a benign verify, caught mechanically.)

## Scope

Only edit `lib/ccWaitlist.ts`; do not edit `verify.sh`, `verify.test.ts` or `TASK.md`.
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
