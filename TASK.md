# TASK: cardBonuses-v2

## Confirmed defect (observed, not suspected)

DEFECT: `lib/cardBonuses.ts` exports `calculateCardBonus(cardValue: number)` that returns `{ bonusTier: string, bonusAmount: number }` with hard-coded bronze/silver/gold tiers. The spec requires `calculateCardBonus(rule, spend)` returning `{ times: number, points: number }` with user-configurable rules. At baseline, the function signature, parameters, and return shape are completely wrong for the spec.

## Entry point

lib/cardBonuses.ts:1

## Required change

lib/cardBonuses.ts (landed 1a53991) hard-codes INVENTED bronze/silver/gold tiers. Card bonuses are USER-CONFIGURED: the user sets a rule 'earn P points per D dollars spent, up to M times'. REPLACE the tier logic: export a pure function calculateCardBonus(rule, spend), rule = { points: number, perDollars: number, maxTimes?: number | null } (null OR undefined maxTimes = no cap), returning { times: number, points: number } with times = min(floor(spend / perDollars), floor(maxTimes) ?? Infinity) and points = times * rule.points. Examples rule {points:5, perDollars:100, maxTimes:3}: spend 99 -> 0/0; 100 -> 1/5; 250 -> 2/10; 1000 -> 3/15; maxTimes null AND maxTimes omitted (undefined), spend 1000 -> 10/50. Invalid input never throws and never yields NaN/Infinity, returns {times:0,points:0}: spend negative/NaN/Infinity; perDollars <= 0, NaN or non-finite; points negative, NaN or non-finite; maxTimes < 0 or NaN; maxTimes 0 -> 0. Fractional maxTimes floored. Floating-point must not under-count at exact multiples (perDollars 0.1, spend 0.3 -> 3 times; perDollars 0.01 spend 0.07 -> 7). NO invented tiers or default rules: a result must come only from the passed rule, and spend 55/500 with different rules must give different results (no tier table). Remove old tier exports; keep file dependency-free.

## Exact behaviour contract

| input | result | why |
|---|---|---|
| spend 0, -0, or negative (any finite) | {times:0, points:0} (never -0) | nothing spent, nothing earned |
| spend not a finite number (NaN, +/-Infinity, string, null, undefined) | {times:0, points:0} | invalid input never throws |
| rule null/undefined, or rule.perDollars not a finite number > 0 (string, null, missing, 0, negative, NaN, Infinity) | {times:0, points:0} | invalid rule |
| rule.points not a finite number >= 0 (string, null, missing, negative, NaN, +/-Infinity) | {times:0, points:0} | invalid rule |
| rule.points === 0 | {times: <computed times>, points: 0} | 0 is a valid points value; it is NOT rejected |
| maxTimes null or undefined (or omitted) | uncapped | no cap |
| maxTimes NaN, or a non-number such as the string '3' | {times:0, points:0} | invalid cap |
| maxTimes negative, 0, or fractional below 1 (0.9) | {times:0, points:0} | floor(maxTimes) is the cap, never below 0 |
| maxTimes 2.9, spend 1000, rule {5,100} | {times:2, points:10} | fractional cap floored |
| perDollars 0.1, spend 0.3 / perDollars 0.01, spend 0.07 / perDollars 0.1, spend 0.7 | times 3 / 7 / 7 | exact multiples must not under-count; use a small epsilon (1e-9) before floor |
| perDollars 0.1, spend 0.29 / perDollars 100, spend 99.99 | times 2 / 0 | near misses must NOT round up |
| computed points or times would overflow to Infinity (spend 1e308, perDollars 0.001, no cap; or points 1e200 with times 1e200) | {times:0, points:0} | never return Infinity/NaN; with maxTimes 3 the same spend gives {times:3, points:3} |

Implementation guidance: validate with Number.isFinite (it is already false for strings, null and undefined); compute `earned = Math.floor(spend / perDollars + 1e-9)`; `times = Math.max(0, Math.min(earned, cap))` where cap is `Math.floor(maxTimes)` or Infinity; `points = times * rule.points`; if points is not finite return zero.

Behaviour that must NOT change:
- The file remains a pure ES module with no side effects.
- The file remains dependency-free (no imports from other project modules).

## Must contain

- `calculateCardBonus`
- `rule`
- `spend`
- `points`
- `perDollars`
- `maxTimes`
- `times`
- `floor`
- `min`
- `Infinity`
- `NaN`
- `CardBonusResult`
- `export function calculateCardBonus`
- `times: number`
- `points: number`
- `perDollars: number`
- `maxTimes?: number | null`
- `null`
- `undefined`

## Scope

Only edit `lib/cardBonuses.ts`; do not edit `verify.sh`, `verify.test.ts` or `TASK.md`.
verify.test.ts is the test fixture -- changing it invalidates the check.
