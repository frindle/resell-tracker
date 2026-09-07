# TASK: bfmr-no-autosubmit

## Confirmed defect (observed, not suspected)

A tracking number uploaded to a BFMR order was auto-submitted to BFMR with the
WRONG QUANTITY, without the user linking it to a reservation. Confirmed in code:
`lib/autoSubmitTracking.ts` has a `buyerName.includes('bfmr')` branch that builds
`bfmrTrackingMap` and calls `bfmrWeb.submitTracking` (via
`await import('@/lib/bfmrWeb')`). That submit path has NO quantity awareness —
that is the wrong-quantity bug.

Policy: BG and BigSky MAY auto-submit tracking; BFMR must NEVER auto-submit.
BFMR tracking goes out ONLY via the manual reservation-linker
(`submitTrackingForReservation`), which is quantity/split-aware through
`lib/bfmrPushGate.ts`.

## Entry point

- `lib/autoSubmitTracking.ts:44` — the inline `buyerName.includes(...)` if/else
  chain (roughly lines 44-71).
- `lib/autoSubmitTracking.ts:23` — the prisma `include` carrying `bfmrLinks`.
- `lib/autoSubmitTracking.ts:112` — the BFMR submit block (roughly lines 112-134).

## Required change

1. NEW pure module `lib/autoSubmitChannel.ts`:
   - `export type AutoSubmitChannel = 'BG' | 'BigSky';`
   - `export function autoSubmitChannel(buyerName: string | null | undefined): AutoSubmitChannel | null`
     returning `'BG'` for names including `buyinggroup`/`buying group`
     (case-insensitive), `'BigSky'` for `bigsky`/`big sky`, and `null` for BFMR
     and everything else. Document WHY BFMR is `null` (manual-only, quantity-aware
     path).

2. EDIT `lib/autoSubmitTracking.ts`:
   - Add `import { autoSubmitChannel } from '@/lib/autoSubmitChannel';`.
   - Replace the inline `buyerName.includes(...)` if/else chain with
     `autoSubmitChannel(order.buyer?.name)` and route on its `'BG'`/`'BigSky'`/
     `null` result. BG and BigSky logic must be UNCHANGED.
   - REMOVE the entire BFMR branch, the `bfmrTrackingMap` / `bfmrOrderIds`
     declarations, the whole BFMR submit block, and the
     `await import('@/lib/bfmrWeb')`.
   - REMOVE the now-unused `bfmrLinks: { include: { reservation: true } }` from
     the prisma `include`, leaving `include: { buyer: true }`.

3. NEW test `lib/autoSubmitChannel.test.ts` in the exact style of
   `lib/bfmrPushGate.test.ts` (Node built-in runner: `import test from 'node:test'`,
   `import assert from 'node:assert/strict'`, and a `.ts` import
   `from './autoSubmitChannel.ts'`). Adversarial cases that matter:
   `'BFMR'`/`'bfmr'`/`'BFMR LLC'` → `null`; `'BuyingGroup'`/`'Buying Group'` →
   `'BG'`; `'BigSky'`/`'Big Sky'` → `'BigSky'`; `'Amazon'` → `null`;
   `null`/`undefined` → `null`.

4. Wire `lib/autoSubmitChannel.test.ts` into the `package.json` `"test"` script
   (append it to the existing `node --experimental-strip-types --test ...` list).

Behaviour that must NOT change:
- BG (`buyinggroup`/`buying group`) and BigSky (`bigsky`/`big sky`) auto-submit
  exactly as before — same tracking lists, same order-id bookkeeping, same
  `trackingSubmittedToBg` update guarded by `locked: false`.
- The existing test suite must stay green.

## Must contain

- `export type AutoSubmitChannel`
- `export function autoSubmitChannel(`
- `autoSubmitChannel(order.buyer?.name)`
- `from '@/lib/autoSubmitChannel'`

(The gate holds the reference impl against this list. If the verify goes green
while one of these is absent from the changed files, the verify does not enforce
the spec.)

## Scope

Only edit `lib/autoSubmitChannel.ts`, `lib/autoSubmitTracking.ts`,
`lib/autoSubmitChannel.test.ts`, and `package.json`. Do not edit `verify.sh`,
`TASK.md`, or any other file.

## Loop instruction

Run `bash verify.sh` after every edit and keep editing until it prints
`VERIFY_OK`. Fix each named FAIL in turn; do not edit `verify.sh` to make it pass.
