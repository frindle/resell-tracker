// Adversarial cases for: rt-bfmr-sync-scope-wiring-v2   (tsx --test / node --test)
//
// The decision module lib/bfmrSyncTrigger.ts is pure, so its behaviour is
// driven directly, and cross-checked against main's REAL scope-plan module
// lib/bfmrSyncScope.ts. The three call sites (route, linker, autoSync) cannot
// be driven without standing up Prisma and a headless BFMR login, and the
// linker is a React component that cannot be mounted in this runner -- so,
// following lib/bfmrSplitWiring.test.ts, we read each file as TEXT and pin the
// exact wiring shapes TASK.md spells out.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { SYNC_TRIGGER_SCOPES, scopeForSyncTrigger } from './lib/bfmrSyncTrigger';
import { parseBfmrSyncScope, resolveBfmrSyncPlan } from './lib/bfmrSyncScope';

const HERE = dirname(fileURLToPath(import.meta.url));
const TRIGGER = join(HERE, 'lib', 'bfmrSyncTrigger.ts');
const ROUTE = join(HERE, 'app', 'api', 'bfmr', 'sync-reservations', 'route.ts');
const LINKER = join(HERE, 'components', 'BfmrReservationLinker.tsx');
const AUTOSYNC = join(HERE, 'lib', 'autoSync.ts');

const FULL_ENUM = 'purchased,reserved,return,payment_error,shipped,processed,set_aside,paid,cancelled,returned,closed,deadline,pkg_received';

// --- the mapping itself ------------------------------------------------------

test('order-open is the ONLY trigger that yields pending; manual and scheduled each yield all', () => {
  assert.equal(scopeForSyncTrigger('order-open'), 'pending');
  // Individually -- a build that narrows EITHER of these silently stops the
  // myTrackerId web backfill from ever converging (worse than the slowness).
  assert.equal(scopeForSyncTrigger('manual'), 'all');
  assert.equal(scopeForSyncTrigger('scheduled'), 'all');

  // And across the whole policy: exactly one key maps to 'pending', and the
  // policy covers exactly the three triggers.
  const values = Object.values(SYNC_TRIGGER_SCOPES);
  assert.equal(values.filter(v => v === 'pending').length, 1);
  assert.deepEqual(Object.keys(SYNC_TRIGGER_SCOPES).sort(), ['manual', 'order-open', 'scheduled']);
  assert.equal(SYNC_TRIGGER_SCOPES['order-open'], 'pending');
  assert.equal(SYNC_TRIGGER_SCOPES.manual, 'all');
  assert.equal(SYNC_TRIGGER_SCOPES.scheduled, 'all');
});

test('case sensitivity: Order-Open / ORDER-OPEN are unknown triggers -> all', () => {
  // The mapping is exact-literal; a case variant must fail safe to the wide
  // scope, never silently narrow.
  assert.equal(scopeForSyncTrigger('Order-Open'), 'all');
  assert.equal(scopeForSyncTrigger('ORDER-OPEN'), 'all');
});

test('unknown / garbage / missing input returns all and does not throw', () => {
  const garbage: unknown[] = [undefined, null, '', 'orderopen', 'order_open', 0, 1, {}, [], () => 'order-open', Symbol('order-open'), { trigger: 'order-open' }];
  for (const g of garbage) {
    assert.equal(scopeForSyncTrigger(g), 'all', `input ${String(typeof g)} must fail safe to 'all'`); // throws -> test fails
  }
  // Never 'full' (the pre-main draft's name) -- the value must be a real BfmrSyncScope.
  assert.notEqual(scopeForSyncTrigger(undefined) as string, 'full');
});

test('SYNC_TRIGGER_SCOPES is frozen and the function still agrees after a mutation attempt', () => {
  assert.equal(SYNC_TRIGGER_SCOPES['order-open'], 'pending');
  // A caller trying to re-point the policy must not change the observable
  // outcome: the value stays put AND scopeForSyncTrigger still returns it.
  // (In strict mode a write to a frozen object throws -- that is itself the
  // pin; either way the mapping must be unchanged afterwards.)
  try {
    (SYNC_TRIGGER_SCOPES as Record<string, string>)['order-open'] = 'all';
  } catch { /* frozen: expected */ }
  try {
    (SYNC_TRIGGER_SCOPES as Record<string, string>).scheduled = 'pending';
  } catch { /* frozen: expected */ }
  try {
    (SYNC_TRIGGER_SCOPES as Record<string, string>).bogus = 'pending';
  } catch { /* frozen: expected */ }
  assert.equal(SYNC_TRIGGER_SCOPES['order-open'], 'pending');
  assert.equal(SYNC_TRIGGER_SCOPES.scheduled, 'all');
  assert.equal(Object.keys(SYNC_TRIGGER_SCOPES).length, 3);
  assert.equal(scopeForSyncTrigger('order-open'), 'pending');
  assert.equal(scopeForSyncTrigger('scheduled'), 'all');
  assert.equal(scopeForSyncTrigger('bogus'), 'all');
});

test('composes with the real scope-plan module: order-open plan skips the web backfill, scheduled/manual run it', () => {
  for (const t of ['order-open', 'manual', 'scheduled', undefined, 'junk']) {
    const scope = scopeForSyncTrigger(t);
    // The returned value is a genuine BfmrSyncScope -- parse round-trips it.
    assert.equal(parseBfmrSyncScope(scope), scope);
  }
  const orderOpen = resolveBfmrSyncPlan(scopeForSyncTrigger('order-open'));
  assert.equal(orderOpen.runWebBackfill, false, 'order-open must never trigger the ~90s scrape');
  assert.ok(orderOpen.filters.every(f => f.status !== FULL_ENUM), 'order-open must not page the full catalogue');
  for (const t of ['manual', 'scheduled', undefined]) {
    const plan = resolveBfmrSyncPlan(scopeForSyncTrigger(t));
    assert.equal(plan.runWebBackfill, true, `${String(t)} must keep the web backfill`);
    assert.ok(plan.filters.some(f => f.status === FULL_ENUM), `${String(t)} must keep the full status enum`);
  }
});

test('module is pure: no clock, network, or DB, and its scope import is type-only', () => {
  const src = readFileSync(TRIGGER, 'utf8');
  for (const banned of ['Date.now(', 'fetch(', 'prisma', '@/lib/db', 'process.env', 'require(']) {
    assert.ok(!src.includes(banned), `lib/bfmrSyncTrigger.ts must not reference ${banned}`);
  }
  const importLines = src.split('\n').filter(l => /^\s*import\b/.test(l));
  assert.ok(importLines.length >= 1, 'must import the BfmrSyncScope type');
  for (const l of importLines) {
    assert.match(l, /^\s*import\s+type\s+\{[^}]*\bBfmrSyncScope\b[^}]*\}\s+from\s+['"](\.\/|@\/lib\/)bfmrSyncScope['"]/,
      `only a type-only import of BfmrSyncScope is allowed, got: ${l.trim()}`);
  }
  assert.ok(src.includes('Object.freeze'), 'the policy must be frozen at runtime');
  assert.ok(!src.includes("'full'"), "scope name is 'all' on main, never 'full'");
});

// --- structural wiring pins (files read as TEXT) ------------------------------

test('route composes resolveBfmrSyncPlan(scopeForSyncTrigger(body.trigger)) and no longer hard-codes the full status enum', () => {
  const src = readFileSync(ROUTE, 'utf8');
  assert.match(src, /import\s*\{[^}]*\bresolveBfmrSyncPlan\b[^}]*\}\s*from\s*'@\/lib\/bfmrSyncScope'/, 'route must import resolveBfmrSyncPlan from @/lib/bfmrSyncScope');
  assert.match(src, /import\s*\{[^}]*\bscopeForSyncTrigger\b[^}]*\}\s*from\s*'@\/lib\/bfmrSyncTrigger'/, 'route must import scopeForSyncTrigger from @/lib/bfmrSyncTrigger');
  assert.ok(src.includes('req.json()'), 'the trigger must come from the request body');
  assert.match(src, /const plan = resolveBfmrSyncPlan\(scopeForSyncTrigger\([^)]*\btrigger\b[^)]*\)\);/, 'scope decision must feed the plan in one expression');
  assert.match(src, /const filters(?:\s*:\s*TrackerFilter\[\])?\s*=\s*plan\.filters;/, 'the tracker filters must come from the plan');
  // The inline filter is gone: the 13-value literal may only live in
  // lib/bfmrSyncScope.ts now.
  assert.ok(!src.includes(FULL_ENUM), 'route must not build the tracker filter inline');
  assert.ok(!src.includes('page_size: 200'), 'route must not build the tracker filter inline');
});

test('route gates the web-backfill scrape on plan.runWebBackfill (the ~90s the order-open path must skip)', () => {
  const src = readFileSync(ROUTE, 'utf8');
  const gated = src.match(/if\s*\(\s*plan\.runWebBackfill\s*&&\s*needsWebBackfill\.length\s*>\s*0\s*\)\s*\{/g) ?? [];
  assert.equal(gated.length, 1, 'exactly one backfill block, gated on plan.runWebBackfill && needsWebBackfill.length > 0');
  assert.ok(!/if\s*\(\s*needsWebBackfill\.length\s*>\s*0\s*\)/.test(src), 'the ungated backfill block must be gone');
  assert.ok(!/!\s*plan\.runWebBackfill/.test(src), 'the gate must not be inverted');
  // The plan is used, not merely computed and dropped: the fast-path pieces the
  // order-open scope still needs stay unconditional.
  assert.ok(src.includes('await autoLinkBfmrReservations(uid)'), 'auto-link must still run');
  assert.ok(src.includes('await findStaleBfmrLinkValues(uid)'), 'stale-link scan must still run');
});

test('linker auto-sync fetch sends the order-open trigger; manual sync does not', () => {
  const src = readFileSync(LINKER, 'utf8');
  // The auto-sync path is entitled to the narrow scope via the trigger literal
  // in the POST body -- pinned to the region between the didAutoSync latch and
  // the .then(() => load()) continuation so a stray literal elsewhere cannot
  // satisfy it.
  const start = src.indexOf('didAutoSync.current = true');
  assert.ok(start !== -1, 'linker must still latch didAutoSync.current before the auto-sync fetch');
  const end = src.indexOf('.then(() => load())', start);
  assert.ok(end !== -1, 'auto-sync fetch must still chain .then(() => load())');
  const autoRegion = src.slice(start, end);
  assert.ok(autoRegion.includes("fetch('/api/bfmr/sync-reservations'"), 'auto-sync must still POST /api/bfmr/sync-reservations');
  assert.match(autoRegion, /method:\s*'POST'/, 'auto-sync must still be a POST');
  assert.match(autoRegion, /body:\s*JSON\.stringify\(\{\s*trigger:\s*'order-open'\s*\}\)/, "auto-sync must send { trigger: 'order-open' } in the body");
  const autoFetchLines = autoRegion.split('\n').filter(l => l.includes("fetch('/api/bfmr/sync-reservations'"));
  assert.equal(autoFetchLines.length, 1);
  assert.ok(autoFetchLines[0].includes("trigger: 'order-open'"), 'keep the body on the fetch line (single exercised line)');
  // Exactly one order-open trigger is SENT from the whole component: the auto-sync one.
  assert.equal(src.split("trigger: 'order-open'").length - 1, 1, "trigger: 'order-open' must be sent exactly once in the linker");

  // The MANUAL sync function must NOT carry the order-open trigger -- it keeps
  // the full scope. Find its fetch and assert the trigger literal is absent.
  const manualIdx = src.indexOf('async function sync()');
  assert.ok(manualIdx !== -1, 'linker must still have a manual sync() function');
  const manualRegion = src.slice(manualIdx, src.indexOf('readApiResponse', manualIdx));
  assert.ok(manualRegion.includes("fetch('/api/bfmr/sync-reservations', { method: 'POST' })"), 'manual sync must still POST /api/bfmr/sync-reservations with no body');
  assert.ok(!manualRegion.includes('order-open'), "manual sync must not use the 'order-open' trigger");
  assert.ok(!manualRegion.includes('trigger'), 'manual sync must not send any trigger');
});

test('autoSync loopback POST is NOT on the order-open trigger (scheduled keeps full scope)', () => {
  const src = readFileSync(AUTOSYNC, 'utf8');
  const line = src.split('\n').find(l => l.includes("loopbackPost('/api/bfmr/sync-reservations'"));
  assert.ok(line !== undefined, 'autoSync must still loopback-POST /api/bfmr/sync-reservations');
  assert.ok(!line!.includes('order-open'), "scheduled sync must not use the 'order-open' trigger");
  assert.ok(!line!.includes('pending'), 'scheduled sync must not narrow its scope');
  assert.ok(!src.includes('order-open'), "no order-open trigger anywhere in the scheduler");
});
