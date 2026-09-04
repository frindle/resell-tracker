# Fix: an order is marked "BG Credited" when only SOME of its shipments are credited

## The symptom (observed in production)
Order **899** shipped in **2 packages**. Only **1 of the 2** packages has been
credited by the buying group so far. Yet the order shows **BG Credited: yes**.

That is wrong. An order must show **BG Credited: yes only when EVERY one of its
shipments has been credited** — if even one shipment is still uncredited, the
order is NOT yet BG-credited.

An order's shipments are its tracking numbers: `Order.trackingNumbers` is a
comma-separated string, so a 2-package order has 2 tracking numbers. The
`bgCredited` boolean is set during the buying-group receipt sync.

## What to do
1. **Find** where `bgCredited` is decided during the BG receipt sync. It lives
   in `lib/bgSync.ts` (the `runBgReceiptSync` path). Right now the decision
   collapses to "did ANY receipt for this order come in-balance" — that is the
   bug. It must become "did EVERY shipment of this order come in-balance".

2. **Extract the decision into a pure, unit-testable function**, following the
   existing repo convention (`lib/paymentStatus.ts` is pure logic split out of a
   page for exactly this reason). Create `lib/bgCredited.ts` exporting **this
   exact signature** (the test below imports it verbatim):

   ```ts
   export function isOrderFullyCredited(
     orderTrackings: string[],
     creditedTrackings: Set<string>,
   ): boolean
   ```

   - `orderTrackings`: the order's distinct shipment tracking tokens.
   - `creditedTrackings`: the tracking tokens that received an in-balance
     receipt this sync.
   - Return `true` only when the order has at least one shipment AND every one
     of `orderTrackings` is present in `creditedTrackings`. Empty
     `orderTrackings` ⇒ `false` (nothing to credit).

3. **Rewire `runBgReceiptSync`** to use it. Instead of a single
   `Set<orderId>` that flips on the first in-balance receipt, accumulate, per
   order, the SET of that order's tracking tokens that came in-balance, then set
   `bgCredited = true` only when `isOrderFullyCredited(orderTrackings, credited)`
   holds. Preserve existing behavior otherwise (idempotency: still only write
   when it changes; leave `bgPaidAmount`, mismatch, paid/overdue logic as-is).

4. **Add `lib/bgCredited.test.ts`** (co-located unit test, same style as
   `lib/paymentStatus.test.ts`) and **wire it into the `test` script in
   `package.json`** alongside the other `lib/*.test.ts` files.

## Property that must hold (this is how the work is judged)
- 2 shipments, 1 credited → NOT credited.
- 2 shipments, 2 credited → credited.
- 1 shipment credited → credited; 1 shipment none credited → NOT credited.
- A credited tracking belonging to a DIFFERENT order must not count.

## Constraints
- Edit **only** files under this worktree. Do NOT touch any `rt-wt-*/`
  sub-checkout — those are unrelated duplicate trees.
- Keep TypeScript type-strip clean: the repo's tests run on
  `node --experimental-strip-types`; real (non-type-only) imports need explicit
  `.ts` extensions (see `lib/paymentStatus.ts`). There is NO global `tsc` gate.
- No new dependencies.

## How to check your work
`bash verify.sh` from the worktree root must print `VERIFY_OK`. It runs the
adversarial gate test against `lib/bgCredited.ts`, confirms `lib/bgSync.ts`
actually calls `isOrderFullyCredited`, and strip-checks the edited sync file.
