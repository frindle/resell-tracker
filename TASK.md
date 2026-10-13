# TASK: rt-card-bonus-lib-rq

## Confirmed defect (observed, not suspected)

BEHAVIOR TO ADD (no defect observed at baseline): `calculateCardBonus` at lib/cardBonuses.ts:1 does not exist; this change adds it.

## Entry point

lib/cardBonuses.ts:1

## Required change

Implement a `calculateCardBonus` function that computes gift card bonus amounts based on card value and bonus tier rules. The function takes a card value (number) and returns a bonus object with tier and amount.

Behaviour that must NOT change:
- The module must remain a pure ES module with no side effects
- The `export {}` stub must be replaced with the real export

## Must contain

- `calculateCardBonus`
- `cardValue`
- `bonusTier`
- `bonusAmount`
- `CardBonusResult`

## Scope

Only edit `lib/cardBonuses.ts`; do not edit `verify.sh`, `verify.test.ts` or `TASK.md`.
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
