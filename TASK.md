# TASK: rt-cancelled-no-reservation-chip

## Confirmed defect (observed, not suspected)

On `app/orders/page.tsx`, the `GroupWarningChips` component renders a yellow
"No reservation" chip for any order where `(o.bfmrLinks ?? []).length === 0 &&
!o.bfmrStatus && !o.salePriceSynced && /bfmr/i.test(o.buyer.name)` (line ~321).
Its sibling chips ("No tracking", "No commitment") both begin with a
`!o.cancelled` guard; this one does not. So a **cancelled** BFMR order that has
no linked reservation still shows the "No reservation" warning chip, while its
sibling warnings are correctly suppressed. Verified by reading the JSX: the
condition at line ~321 is the only chip condition in `GroupWarningChips`
lacking `!o.cancelled`.

## Entry point

app/orders/page.tsx:321 (the `{(o.bfmrLinks ?? []).length === 0 && !o.bfmrStatus && ...}` line inside `GroupWarningChips`)

## Required change

A cancelled order must never show the 'No reservation' warning chip. In app/orders/page.tsx the GroupWarningChips 'No reservation' chip renders when bfmrLinks is empty && !bfmrStatus && !salePriceSynced && /bfmr/i.test(buyer.name), but unlike its sibling chips ('No tracking','No commitment') it lacks the !o.cancelled guard, so cancelled bfmr orders with no linked reservation still show it. A cancelled order needs no reservation.

Extract the chip's boolean condition into an exported pure predicate
`shouldShowNoReservationChip(o)` in `app/orders/page.tsx`, add the missing
`!o.cancelled` guard inside it (return false for cancelled orders), and have
the JSX call `{shouldShowNoReservationChip(o) && (...)}`. The predicate must be
pure (no React, no I/O) so it can be imported directly from a test:
`import { shouldShowNoReservationChip } from './app/orders/page'`.

Behaviour that must NOT change:
- Non-cancelled BFMR orders with empty `bfmrLinks`, null `bfmrStatus`, and
  `salePriceSynced === false` still show the chip (predicate returns true).
- The chip is still suppressed when any of these hold: a bfmr link exists,
  `bfmrStatus` is set, or `salePriceSynced` is true.
- Non-BFMR buyer names (e.g. "BuyingGroup", "BigSky") never show the chip.
- Degenerate inputs (`bfmrLinks` undefined/missing, `buyer` null) must not
  throw; they return false.
- The sibling chips ("No tracking", "No commitment", "Tracking not uploaded",
  "Wrong group", "CC pending") keep rendering exactly as before.

## Must contain

- `export function shouldShowNoReservationChip(o: Order): boolean {`
- `{shouldShowNoReservationChip(o) && (`
- `!o.cancelled && (o.bfmrLinks ?? []).length === 0 && !o.bfmrStatus && !o.salePriceSynced && /bfmr/i.test(`

(The gate holds the reference impl against this list. If the verify goes green
while one of these is absent from the changed files, the verify does not
enforce the spec -- that is a benign verify, caught mechanically.)

## Scope

Only edit `app/orders/page.tsx`; do not edit `verify.sh`, `verify.test.ts` or `TASK.md`.
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
