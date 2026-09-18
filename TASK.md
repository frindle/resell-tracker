# TASK: bfmr-relink-v3

## Confirmed defect (observed, not suspected)

confirmed: reservations 279075/279076 have bfmrOrderId 111-8254681-0840266 (exact digit match to order 929 orderNumber) but their OrderBfmrLink rows point at order 928; order 929 page shows them unlinked because autoLinkBfmrReservations only links zero-link reservations and nothing re-points existing links

## Entry point

lib/bfmrAutoLink.ts:86

## Required change

a stale OrderBfmrLink whose reservation.bfmrOrderId exactly matches a DIFFERENT existing order's orderNumber (and not the current one) is re-pointed to that order; ambiguous cases (null bfmrOrderId, 0 or >1 candidates, duplicate reservation on target, guard fail) are skipped without throwing; a link already matching its order is never stomped

Add a new exported async function `relinkStaleBfmrLinks(userId, orderIds?)` and
call it from `autoLinkBfmrReservations`, immediately after the existing
`await capOverallocatedBfmrLinks(userId);`, as `await relinkStaleBfmrLinks(userId, orderIds);`.
It loads OrderBfmrLink rows (with their reservation's bfmrOrderId) and the orders,
and for each link whose reservation.bfmrOrderId digit-normalizes to a DIFFERENT
order's orderNumber than the one it currently points at, re-points the link's
`orderId` to that order via `prisma.orderBfmrLink.update`, then calls
`recalcBfmrSalePrice` for BOTH the old and the new orderId. Reuse the existing
`normDigits` helper and the same exact-digits / >=7-digit containment rule as
matchByOrderNumber.

Behaviour that must NOT change:
- A link whose reservation.bfmrOrderId ALREADY matches its current order is left
  untouched (never re-pointed, never stomped).
- Ambiguous cases are SKIPPED with a `console.warn`, never throw: reservation
  .bfmrOrderId is null/empty; zero or more than one candidate order matches the
  normalized digits exactly; the target order already has that reservationId
  linked; or `guardLink` against the target returns not-ok.
- The existing zero-link auto-linking (matchByOrderNumber + tracking match) and
  `capOverallocatedBfmrLinks` continue to run exactly as before.
- The function returns the count of links it re-pointed.

## Must contain

- `export async function relinkStaleBfmrLinks`
- `await relinkStaleBfmrLinks(userId, orderIds)`
- `prisma.orderBfmrLink.update`
- `recalcBfmrSalePrice`
- `guardLink`

(The gate holds the reference impl against this list. If the verify goes green
while one of these is absent from the changed files, the verify does not
enforce the spec -- that is a benign verify, caught mechanically.)

(A bare bullet checks the default target. To PIN a literal to a specific file --
useful when a fix spans a helper file and the route/wiring that calls it --
prefix the bullet with `in <path>:`, e.g.
`- in app/api/x/route.ts: ` followed by a backtick-quoted token. Then that
token is required in THAT file, not the target.)

## Scope

Only edit `lib/bfmrAutoLink.ts`; do not edit `verify.sh`, `verify.test.ts` or `TASK.md`.
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
