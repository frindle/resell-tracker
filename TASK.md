# TASK: bfmr-paid-rollup-overcount

## Confirmed defect (observed, not suspected)

Confirmed via 27B diagnosis of order 900 (split BFMR shipment: one leg paid
$1893 + one leg still shipped $631). In `app/api/bfmr/sync-orders/route.ts` the
per-order `status` is derived from the MOST-ADVANCED item (route.ts:195-196),
so `isPaid = PAID_STATUSES.has(status)` (route.ts:271) is true whenever ANY leg
is paid. `totalPayout` (route.ts:205-206) sums `total_payout` over ALL active
items. The paid branch (route.ts:288-303) then sets `patch.locked = true`,
`patch.salePriceSynced = true`, and `patch.bgPaidAmount = totalPayout`. Net
effect: a partially-paid split order is LOCKED and shows the FULL sum as already
paid, when only one leg has actually been paid.

## Entry point

- Add the helper to `lib/bfmr.ts` (alongside `deriveBfmrStatus`).
- Wire it in at `app/api/bfmr/sync-orders/route.ts:271` and the paid branch
  that follows (route.ts:288-303).

## Required change

1. In `lib/bfmr.ts`, add and export a PURE helper:

   ```ts
   export function computeBfmrPaidRollup<T>(
     activeItems: T[],
     isPaid: (item: T) => boolean,
     payoutOf: (item: T) => number | null,
   ): { allPaid: boolean; paidPayout: number | null; totalPayout: number | null }
   ```

   Semantics (the `lib/bfmrPaidRollup.test.ts` suite pins these exactly):
   - Empty `activeItems` -> `{ allPaid: false, paidPayout: null, totalPayout: null }`.
   - `allPaid` is `true` ONLY when EVERY active item satisfies `isPaid` (not "any").
   - `paidPayout` = sum of `payoutOf(item) ?? 0` over ONLY the items where
     `isPaid(item)` is true.
   - `totalPayout` = sum of `payoutOf(item) ?? 0` over ALL active items.
   - A `null` from `payoutOf` counts as 0 in the sums; it must not make a sum
     `null` (only an empty `activeItems` yields `null` sums).

2. In `app/api/bfmr/sync-orders/route.ts`, call the helper on the matched-order
   update path and use its results:
   - `computeBfmrPaidRollup(activeItems, i => PAID_STATUSES.has(dstat(i)), i => parseMoney(i.total_payout))`.
   - Gate `patch.locked` and `patch.salePriceSynced` on `allPaid` (NOT on the
     old any-leg `isPaid`).
   - Write `patch.bgPaidAmount = paidPayout` (NOT `totalPayout`).

## Behaviour that must NOT change

- `bgExpectedPayout` still reflects the FULL expectation (`totalPayout`), exactly
  as route.ts:285-286 does today -- do not switch it to `paidPayout`.
- A FULLY-paid order (every active leg paid) must still lock, still set
  `salePriceSynced = true`, and still write `bgPaidAmount` = the full paid sum
  (which now equals `paidPayout` because every leg is paid).
- Single-item (non-split) paid orders behave exactly as before.
- The order-CREATION path (route.ts:237-268, the `if (!order)` branch) is out of
  scope -- leave it unchanged. Only the matched-order update path changes.

## Must contain

- `computeBfmrPaidRollup`

(The gate holds the reference impl against this list. If the verify goes green
while this literal is absent from the helper file, the verify does not enforce
the spec.)

## Scope

Only edit `lib/bfmr.ts`, `app/api/bfmr/sync-orders/route.ts`; do not edit
`verify.sh`, `lib/bfmrPaidRollup.test.ts` or `TASK.md`.
`lib/bfmrPaidRollup.test.ts` is the test fixture -- changing it invalidates the check.

## Loop instruction

Run `bash verify.sh` after every edit and keep editing until it prints
`VERIFY_OK`.
