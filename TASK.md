# TASK: rt-amazon-card-lastfours

## Confirmed defect (observed, not suspected)

A saved card that has BOTH a primary last4 and authorized-user `lastFours` never auto-assigns on its `lastFours` values. Reproduced by reading the map builder in app/api/import/route.ts: the additional-last4 loop is gated behind `if (lf.last4 && !c.last4)`, so for any card with a primary last4 set, none of its `lastFours` entries are ever registered in `last4ToCard`; an import row whose scraped `paymentLast4` matches one of those values falls through to "no saved card matches" and the order is created with `cardId: null`.

## Entry point

app/api/import/route.ts:205 — the `if (lf.last4 && !c.last4)` guard inside the lastFours loop, just below the primary-last4 branch (~line 196). The card auto-assign map log line is near line 211.

## Required change

In the card auto-assign map builder additional last-4s from CreditCard lastFours are only registered when the card has no primary last4 (the guard if lf.last4 and not c.last4) so a card that has BOTH a primary last4 and authorized-user lastFours never maps its lastFours values and those cards never auto-assign; register each lf.last4 regardless of c.last4 using the same duplicate-collision handling as the primary last4 branch

Behaviour that must NOT change:
- A card with only `lastFours` (no primary last4) still auto-assigns on its lastFours values.
- Duplicate last4 across cards still resolves to no auto-assign (`last4ToCard` entry set to null), including the new collision where one card's lastFours value equals another card's primary last4.
- An explicit `cardId` in the row still wins; rate-based disambiguation via `paymentRatePercent` and the `[import] card auto-assign map:` log line are untouched.

## Must contain

- `if (lf.last4) {`

## Scope

Only edit `app/api/import/route.ts`; do not edit `verify.sh`, `verify.test.ts` or `TASK.md`.
verify.test.ts is the test fixture -- changing it invalidates the check.

## Keep every changed line exercised (relevance)

The fix should be a single-line guard change: drop the `!c.last4` condition from the lastFours loop so its body runs for cards with a primary last4 too, keeping the existing duplicate-collision handling inside. Do not add new untested lines; the behavioural fixture drives the real POST handler and asserts the created order's cardId in each scenario above.

## Loop instruction

Run `bash verify.sh` after every edit and keep editing until it prints
`VERIFY_OK`.
