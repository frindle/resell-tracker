# TASK: rt-bfmr-sync-scope-wiring-v2

## Confirmed defect (observed, not suspected)

`app/api/bfmr/sync-reservations/route.ts` has exactly ONE mode. It pages `/my-tracker` over the complete 13-value status enum at `page_size 200` (the whole ~759-row catalogue), and then -- whenever any reservation still has `myTrackerId` null and was not stamped inside the per-ROW 24h `WEB_BACKFILL_RETRY_WINDOW_MS` -- runs a headless BFMR login plus full Web-App tracker scrape (~90s of the route's ~93-99s). Verified by reading the route source at main: the inline `filters` array (route.ts ~line 43-48) hard-codes the full status enum, and the web-backfill block `if (needsWebBackfill.length > 0) {` is unconditional on who called. `components/BfmrReservationLinker.tsx:168` fires that same unscoped route on EVERY unlinked-order open (the non-blocking auto-sync fetch inside the `useEffect`), so opening an order page can trigger a ~90s scrape for no reason.

`lib/bfmrSyncScope.ts` ALREADY EXISTS on main and is the scope-plan module: `export type BfmrSyncScope = 'all' | 'pending'` and `export function resolveBfmrSyncPlan(scope: BfmrSyncScope): { filters, runWebBackfill, runStaleLinkScan, runAutoLink }` ('all' -> full status enum + backfill; 'pending' -> narrow `action_needed` filter, no web backfill). Nothing calls it yet. This task WIRES it.

## Entry point

components/BfmrReservationLinker.tsx:168 (`fetch('/api/bfmr/sync-reservations', { method: 'POST' })` inside the auto-sync `useEffect`)

## Required change

Create lib/bfmrSyncTrigger.ts (NEW pure decision module -- no DB, no network, no clock): decide WHICH `BfmrSyncScope` each caller of POST /api/bfmr/sync-reservations is entitled to, and wire the call sites onto it.

Export exactly: `BfmrSyncTrigger`, `SYNC_TRIGGER_SCOPES`, `scopeForSyncTrigger`.

```ts
import type { BfmrSyncScope } from './bfmrSyncScope';   // TYPE-ONLY import: keeps the module pure

export type BfmrSyncTrigger = 'order-open' | 'manual' | 'scheduled';

export const SYNC_TRIGGER_SCOPES: Readonly<Record<BfmrSyncTrigger, BfmrSyncScope>> = Object.freeze({
  'order-open': 'pending',
  manual: 'all',
  scheduled: 'all',
});

export function scopeForSyncTrigger(trigger: unknown): BfmrSyncScope
```

- `'order-open'` -> `'pending'` (the narrow, cheap pull -- the ONLY trigger that gets it)
- `'manual'`     -> `'all'`
- `'scheduled'`  -> `'all'`
- Any unrecognised value (`undefined`, `null`, `''`, `'ORDER-OPEN'`, `'Order-Open'`, `'orderopen'`, `0`, `{}`) returns `'all'`. Fail-safe direction: an unknown trigger must never silently narrow a sync. It must not throw for ANY input type -- the parameter is `unknown` on purpose so the route can pass `body?.trigger` straight in.
- The scope strings are main's real `BfmrSyncScope` values `'all'` and `'pending'` (NOT `'full'`). The import from `./bfmrSyncScope` must be `import type` -- a value import would drag `@/lib/bfmr` into the pure module.

`SYNC_TRIGGER_SCOPES` is the frozen trigger->scope mapping the function reads. Must be immutable at runtime (`Object.freeze`) so a caller cannot mutate the policy and silently re-point a trigger.

Hard properties (the verify pins all of these):
- `'order-open'` is the ONLY input that yields `'pending'`. Each of `'manual'` and `'scheduled'` yields `'all'` individually, AND iterating every key of `SYNC_TRIGGER_SCOPES` finds exactly one whose value is `'pending'`. A plausible-wrong build that narrows the scheduled sync keeps the page fast and quietly stops the background sync from ever running the myTrackerId web backfill -- the backfill would then NEVER converge, which is worse than the slowness being fixed.
- Case sensitivity: `'Order-Open'` and `'ORDER-OPEN'` return `'all'`, not `'pending'`.
- Unknown/garbage/missing input returns `'all'` and does not throw (undefined, null, '', 'orderopen', 0, {}).
- `SYNC_TRIGGER_SCOPES` is frozen: a write to an existing key does not change it, and a subsequent `scopeForSyncTrigger` call still returns the original value.
- Composes with main's scope module: `parseBfmrSyncScope(scopeForSyncTrigger(t)) === scopeForSyncTrigger(t)` for every trigger (the returned value IS a valid `BfmrSyncScope`), `resolveBfmrSyncPlan(scopeForSyncTrigger('order-open')).runWebBackfill === false`, and `resolveBfmrSyncPlan(scopeForSyncTrigger('scheduled')).runWebBackfill === true`.
- Pure: no Date.now(), no fetch, no prisma, no I/O; the only import is `import type { BfmrSyncScope } from './bfmrSyncScope'`.

PLUS structural wiring pins. The route cannot be driven without standing up Prisma and a headless BFMR login, and BfmrReservationLinker.tsx is a React component that cannot be mounted in this runner -- so the verify reads each file as TEXT (following lib/bfmrSplitWiring.test.ts) and pins these EXACT shapes:

1. `app/api/bfmr/sync-reservations/route.ts`:
   - imports `resolveBfmrSyncPlan` from `@/lib/bfmrSyncScope` and `scopeForSyncTrigger` from `@/lib/bfmrSyncTrigger`;
   - reads the trigger from the JSON body and composes the two decisions in ONE expression -- the source must contain `resolveBfmrSyncPlan(scopeForSyncTrigger(` and `req.json()`. Recommended shape, replacing the inline `const filters: TrackerFilter[] = [ { status: '...13 values...', page_size: 200 } ];` block:
     ```ts
     const body = await req.json().catch(() => null) as { trigger?: unknown } | null;
     const plan = resolveBfmrSyncPlan(scopeForSyncTrigger(body?.trigger));
     const filters: TrackerFilter[] = plan.filters;
     ```
     (an empty/absent body -> `null` -> trigger `undefined` -> `'all'`: the extension and the loopback scheduler keep the full scope without changes);
   - the source must contain `= plan.filters` and must NO LONGER contain the hard-coded 13-value status literal `purchased,reserved,return,payment_error,shipped,processed,set_aside,paid,cancelled,returned,closed,deadline,pkg_received` (it lives only in lib/bfmrSyncScope.ts now);
   - the web-backfill block is gated on the plan: `if (needsWebBackfill.length > 0) {` becomes exactly `if (plan.runWebBackfill && needsWebBackfill.length > 0) {`. This is THE line that stops the ~90s scrape on order-open. Nothing else in the backfill block changes.
   - Do not change auth, the dedup/upsert loop, autoLink, the stale-link scan, or the response shape.
2. `components/BfmrReservationLinker.tsx`:
   - the auto-sync fetch (the one right after `didAutoSync.current = true;`) sends the trigger in the body, on ONE line: `fetch('/api/bfmr/sync-reservations', { method: 'POST', body: JSON.stringify({ trigger: 'order-open' }) })` -- the text between `didAutoSync.current = true` and `.then(() => load())` must contain `trigger: 'order-open'`;
   - the MANUAL `async function sync()` keeps `fetch('/api/bfmr/sync-reservations', { method: 'POST' })` unchanged -- its fetch line must NOT contain `order-open` (manual keeps the full scope).
3. `lib/autoSync.ts`: the `loopbackPost('/api/bfmr/sync-reservations', u.uid)` line must NOT contain `order-open` -- the scheduled sync keeps the full scope so the web backfill still runs somewhere. Leaving that file untouched satisfies this (no body -> `'all'`).

Behaviour that must NOT change:
- The manual sync button and the scheduled auto-sync keep the FULL scope (full status enum + web backfill still runs on schedule).
- Unknown triggers fail safe to `'all'` -- never to `'pending'`.
- `scopeForSyncTrigger` is pure and total: it never throws, regardless of input type.
- lib/bfmrSyncScope.ts is NOT edited.

## Must contain

- `BfmrSyncTrigger`
- `SYNC_TRIGGER_SCOPES`
- `scopeForSyncTrigger`
- `import type { BfmrSyncScope }`
- `Object.freeze`
- `order-open`
- `manual`
- `scheduled`
- `pending`
- `'all'`
- in app/api/bfmr/sync-reservations/route.ts: `resolveBfmrSyncPlan(scopeForSyncTrigger(`
- in app/api/bfmr/sync-reservations/route.ts: `plan.runWebBackfill && needsWebBackfill.length > 0`
- in components/BfmrReservationLinker.tsx: `trigger: 'order-open'`

## Scope

Only edit `lib/bfmrSyncTrigger.ts`, `app/api/bfmr/sync-reservations/route.ts`, `components/BfmrReservationLinker.tsx` (and, optionally, `lib/autoSync.ts`); do not edit `lib/bfmrSyncScope.ts`, `verify.sh`, `verify.test.ts` or `TASK.md`.
verify.test.ts is the test fixture -- changing it invalidates the check.

## Keep every changed line exercised (relevance)

After the job runs, a mutation check flips/deletes each line you changed and asks the verify to catch it. A changed line whose every mutant survives -- because no test asserts it -- FAILS the gate even when the fix is correct, and the review never runs. So do NOT emit an isolated, untested line:
- Keep the route's three new lines exactly as the recommended shape above (each is pinned by text); do not spread the fetch body over several lines in the linker -- keep it on the one fetch line.
- Do not add helper constants, extra exports, or a standalone `default` branch line that nothing asserts; the mapping object + one function is the whole module.
- If a line genuinely cannot be asserted and cannot be folded, it usually should not be a separate line at all -- restructure so it isn't.

## Loop instruction

Run `bash verify.sh` after every edit and keep editing until it prints `VERIFY_OK`.
