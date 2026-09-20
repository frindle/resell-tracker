# TASK: rt-bfmr-409-logging-p1

## Confirmed defect (observed, not suspected)

Tracking submissions fail with a 409 against BFMR with zero request-level logging. Reproduced live: the route returns 409 for reservations that have no `bfmrOrderId` or no `myTrackerId`, and docker logs are empty on repro — neither early-409 branch in `app/api/bfmr/submit-reservation-tracking/route.ts` writes anything queryable (no `logApiError` row, so nothing under GET /api/api-errors either).

## Entry point

`app/api/bfmr/submit-reservation-tracking/route.ts`: the two early 409 return sites in `POST` — `if (!reservation.bfmrOrderId)` and `if (reservation.myTrackerId == null)`.

## Required change

Live bug: tracking submissions fail with a 409 against BFMR with zero request-level logging (confirmed empty docker logs on live repro). This route has two early 409 return sites -- one when the reservation has no bfmrOrderId, one when it has no myTrackerId -- neither is logged anywhere queryable. Fix (narrow, part 1 of a multi-part instrumentation pass): wire ONLY these two specific 409 branches through the existing logApiError helper from `lib/apiErrorLog.ts` (already used elsewhere in this codebase — read one call site such as `lib/autoSubmitTracking.ts` for the exact import/call idiom, e.g. `void logApiError({ ... })`) with context including reservationId and which ID was missing. Do not touch any other catch block, warn path, retry logic, or VERIFY logic in this file -- separate follow-up work. Do not change response status codes or success-path behavior.

Behaviour that must NOT change:
- Both 409 branches still return exactly the same JSON error bodies and `status: 409` as before;
- The unauthenticated path still returns 401, invalid-body paths still return their existing 400s, missing reservation still 404;
- The success path (both IDs present) is untouched — no logApiError call on it, same response shape;
- All other catch blocks, `console.warn`/`console.error` sites, the stale-myTrackerId retry logic, and the reconcile/VERIFY block are byte-for-byte unchanged.

## Must contain

- `import { logApiError } from '@/lib/apiErrorLog';`
- `void logApiError({`
- `export function findMissingBfmrId(`
- `has no bfmrOrderId — cannot submit tracking`
- `has no myTrackerId — cannot submit tracking`

(All bullets above check the default target file; none are pinned to another path.)

## Scope

Only edit `app/api/bfmr/submit-reservation-tracking/route.ts`; do not edit `verify.sh`, `verify.test.ts` or `TASK.md`.
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
This is not about adding bogus assertions for constants; it's about not
leaving a lone line that carries no tested behaviour.

## Loop instruction

Run `bash verify.sh` after every edit and keep editing until it prints
`VERIFY_OK`.
