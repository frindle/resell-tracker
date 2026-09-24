# TASK: rt-bfmr-sync-scope-wiring

## Confirmed defect (observed, not suspected)

`app/api/bfmr/sync-reservations/route.ts` has exactly ONE mode. It pages `/my-tracker` over the complete 13-value status enum at `page_size 200` (the whole ~759-row catalogue), and then -- whenever any reservation still has `myTrackerId` null and was not stamped inside the per-ROW 24h `WEB_BACKFILL_RETRY_WINDOW_MS` -- runs a headless BFMR login plus full Web-App tracker scrape (~90s of the route's ~93-99s). Verified by reading the route source: the inline `filters` array hard-codes the full status enum, and the web-backfill block is unconditional on scope. `components/BfmrReservationLinker.tsx:168` fires that same unscoped route on EVERY unlinked-order open (the non-blocking auto-sync fetch), so opening an order page can trigger a ~90s scrape for no reason.

## Entry point

lib/bfmrSyncTrigger.ts:2 (stub -- `export {};`)

## Required change

In lib/bfmrSyncTrigger.ts (NEW pure decision module -- no DB, no network, no clock, and NO import from lib/bfmrSyncScope.ts, which is being authored concurrently and does not exist in this tree): decide WHICH sync scope each caller of POST /api/bfmr/sync-reservations is entitled to, and wire the three existing call sites onto it.

Export exactly: `BfmrSyncTrigger`, `SYNC_TRIGGER_SCOPES`, `scopeForSyncTrigger`.

```ts
export type BfmrSyncTrigger = 'order-open' | 'manual' | 'scheduled';
```

The scope strings are the plain literals `'pending'` and `'full'` -- declare them locally (a `BfmrSyncScopeName` string-literal union). Do NOT import from lib/bfmrSyncScope.ts; that module is being authored in a separate dispatch and an import would not resolve.

```ts
export function scopeForSyncTrigger(trigger: BfmrSyncTrigger): BfmrSyncScopeName
```

- `'order-open'` -> `'pending'` (the narrow, cheap pull -- the ONLY trigger that gets it)
- `'manual'`     -> `'full'`
- `'scheduled'`  -> `'full'`
- Any unrecognised value (`undefined`, `null`, `''`, `'ORDER-OPEN'`, a typo, a number, an object) returns `'full'`. Fail-safe direction: an unknown trigger must never silently narrow a sync. It must not throw.

`SYNC_TRIGGER_SCOPES` is the frozen trigger->scope mapping the function reads. Must be deeply immutable at runtime (`Object.freeze`) so a caller cannot mutate the policy and silently re-point a trigger.

Hard properties (the verify pins all of these):
- `'order-open'` is the ONLY input that yields `'pending'`. Each of `'manual'` and `'scheduled'` yields `'full'` individually, AND iterating every key of `SYNC_TRIGGER_SCOPES` finds exactly one whose value is `'pending'`. A plausible-wrong build that narrows the scheduled sync keeps the page fast and quietly stops the background sync from ever running the myTrackerId web backfill -- the backfill would then NEVER converge, which is worse than the slowness being fixed.
- Case sensitivity: `'Order-Open'` and `'ORDER-OPEN'` return `'full'`, not `'pending'`.
- Unknown/garbage/missing input returns `'full'` and does not throw (undefined, null, '', 'orderopen', 0, {}).
- `SYNC_TRIGGER_SCOPES` is frozen: a write to an existing key does not change it, and a subsequent `scopeForSyncTrigger` call still returns the original value. Assert the observable outcome -- the value is unchanged and the function still agrees -- not merely that `Object.isFrozen` returns true.
- Pure: no Date.now(), no fetch, no prisma, no I/O.

PLUS structural wiring pins (the route cannot be driven without standing up Prisma and a headless BFMR login, and BfmrReservationLinker.tsx is a React component that cannot be mounted in this runner -- so the verify reads each file as TEXT, following lib/bfmrSplitWiring.test.ts):
- `app/api/bfmr/sync-reservations/route.ts` references `resolveBfmrSyncPlan`, and no longer builds its tracker filter inline: the source must no longer contain the hard-coded 13-value status literal outside of lib/bfmrSyncScope.ts.
- `components/BfmrReservationLinker.tsx` references `scopeForSyncTrigger` (or the `'order-open'` trigger literal) at its auto-sync fetch, and its MANUAL sync function does not use the order-open trigger.
- `lib/autoSync.ts`'s loopback POST to `/api/bfmr/sync-reservations` is NOT on the order-open trigger -- the scheduled sync must keep the full scope so the web backfill still runs somewhere.

Only lib/bfmrSyncTrigger.ts is the edit target for the decision logic; the route/component/autoSync edits are what the structural pins force. (lib/bfmrSyncScope.ts may be created as a minimal placeholder supplying `resolveBfmrSyncPlan` if it is absent, so the route import resolves -- its real body lands in the sibling dispatch.)

Behaviour that must NOT change:
- The manual sync button and the scheduled auto-sync keep the FULL scope (full status enum + web backfill still runs on schedule).
- Unknown triggers fail safe to `'full'` -- never to `'pending'`.
- `scopeForSyncTrigger` is pure and total: it never throws, regardless of input type.

## Must contain

- `BfmrSyncTrigger`
- `SYNC_TRIGGER_SCOPES`
- `scopeForSyncTrigger`
- `order-open`
- `manual`
- `scheduled`
- `pending`
- `full`
- in app/api/bfmr/sync-reservations/route.ts: `resolveBfmrSyncPlan`

## Scope

Only edit `lib/bfmrSyncTrigger.ts`; do not edit `verify.sh`, `verify.test.ts` or `TASK.md`.
verify.test.ts is the test fixture -- changing it invalidates the check.

## Keep every changed line exercised (relevance)

After the job runs, a mutation check flips/deletes each line you changed and asks the verify to catch it. A changed line whose every mutant survives -- because no test asserts it -- FAILS the gate even when the fix is correct, and the review never runs. So do NOT emit an isolated, untested line:
- Fold an unavoidable constant onto a line the test already exercises. Put a `timeout=` / a `daemon=True` flag / a small tuning number on the SAME line as a header dict, URL, or argument the fixture checks -- never on its own line.
- Prefer falling through to an implicit `return None` over a standalone `return None` in an `except:` the tests do not assert.
- If a line genuinely cannot be asserted and cannot be folded, it usually should not be a separate line at all -- restructure so it isn't.
This is not about adding bogus assertions for constants; it is about not leaving a lone line that carries no tested behaviour.

## Loop instruction

Run `bash verify.sh` after every edit and keep editing until it prints `VERIFY_OK`.
