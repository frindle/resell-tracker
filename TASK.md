# TASK: rt-reservation-remaining

## Confirmed defect (observed, not suspected)

confirmed: no pure function computes a BFMR reservation's REMAINING ordered quantity accounting for cancelled units. recalcBfmrSalePrice (lib/bfmrSalePrice.ts:135) subtracts RETURNED units per link (soldQty = max(0, l.quantity - returned)) but nothing subtracts item-level CANCELLED units, and amazon.js:131 only skips WHOLE cancelled orders. So when one unit of a multi-unit linked order is cancelled, it still counts toward the reservation -> over-count (same class as the phantom-link overcount, commit 2462a89). Also needed so a group MOVE/re-link recomputes remaining for both old and new reservation.

## Entry point

lib/reservationRemaining.ts:1

## Required change

reservationRemaining(requiredQty, links) returns {ordered, remaining, overfilled}: ordered = sum over links of max(0, quantity - cancelledQty - returnedQty), each link's effective units floored at 0; remaining = max(0, requiredQty - ordered); remaining rises when cancelledQty rises (a cancelled unit reopens the reservation); overfilled true when ordered > requiredQty

Create the NEW file `lib/reservationRemaining.ts`. Export interfaces
ReservationLink { quantity: number; cancelledQty?: number; returnedQty?: number }
and ReservationCoverage { ordered: number; remaining: number; overfilled: boolean },
and a pure function reservationRemaining(requiredQty, links): ReservationCoverage.

Rules the tests enforce:
- Each link's EFFECTIVE units = max(0, quantity - cancelledQty - returnedQty),
  floored at 0 (never negative even if cancelled/returned exceed quantity).
- ordered = sum of effective units over all links.
- remaining = max(0, requiredQty - ordered) -- never negative.
- overfilled = ordered > requiredQty.
- A cancelled (or returned) unit lowers `ordered` and therefore RAISES
  `remaining` versus the uncancelled case -- this is how a reservation reopens.
- Missing cancelledQty/returnedQty default to 0; empty/non-array links -> ordered 0.
- Pure function: no I/O, no imports beyond the declared types.

## Must contain

- `export function reservationRemaining`
- `cancelledQty`
- `overfilled`

(The gate holds the reference impl against this list. If the verify goes green
while one of these is absent from the changed files, the verify does not
enforce the spec -- that is a benign verify, caught mechanically.)

## Scope

Only edit `lib/reservationRemaining.ts`; do not edit `verify.sh`, `verify.test.ts` or `TASK.md`.
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
