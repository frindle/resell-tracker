// Adversarial cases for: rt-bfmr-sync-scope-wiring   (node --test / tsx --test)
//
// The decision module lib/bfmrSyncTrigger.ts is pure, so its behaviour is
// driven directly. The three call sites (route, linker, autoSync) cannot be
// driven without standing up Prisma and a headless BFMR login, and the linker
// is a React component that cannot be mounted in this runner -- so following
// lib/bfmrSplitWiring.test.ts we read each file as TEXT and pin the wiring.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { SYNC_TRIGGER_SCOPES, scopeForSyncTrigger } from './lib/bfmrSyncTrigger';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTE = join(HERE, 'app', 'api', 'bfmr', 'sync-reservations', 'route.ts');
const LINKER = join(HERE, 'components', 'BfmrReservationLinker.tsx');
const AUTOSYNC = join(HERE, 'lib', 'autoSync.ts');

// --- the mapping itself ------------------------------------------------------

test('order-open is the ONLY trigger that yields pending; manual and scheduled each yield full', () => {
  assert.equal(scopeForSyncTrigger('order-open'), 'pending');
  // Individually -- a build that narrows EITHER of these silently stops the
  // myTrackerId web backfill from ever converging (worse than the slowness).
  assert.equal(scopeForSyncTrigger('manual'), 'full');
  assert.equal(scopeForSyncTrigger('scheduled'), 'full');

  // And across the whole policy: exactly one key maps to 'pending'.
  const values = Object.values(SYNC_TRIGGER_SCOPES);
  assert.equal(values.filter(v => v === 'pending').length, 1);
  assert.ok(Object.keys(SYNC_TRIGGER_SCOPES).includes('order-open'));
});

test('case sensitivity: Order-Open / ORDER-OPEN are unknown triggers -> full', () => {
  // The mapping is exact-literal; a case variant must fail safe to the wide
  // scope, never silently narrow.
  assert.equal(scopeForSyncTrigger('Order-Open' as never), 'full');
  assert.equal(scopeForSyncTrigger('ORDER-OPEN' as never), 'full');
});

test('unknown / garbage / missing input returns full and does not throw', () => {
  const garbage: unknown[] = [undefined, null, '', 'orderopen', 0, {}];
  for (const g of garbage) {
    assert.equal(scopeForSyncTrigger(g as never), 'full'); // throws -> test fails
  }
});

test('SYNC_TRIGGER_SCOPES is frozen and the function still agrees after a mutation attempt', () => {
  const before = SYNC_TRIGGER_SCOPES['order-open'];
  assert.equal(before, 'pending');
  // A caller trying to re-point the policy must not change the observable
  // outcome: the value stays put AND scopeForSyncTrigger still returns it.
  // (In strict mode a write to a frozen object throws -- that is itself the
  // pin; either way the mapping must be unchanged afterwards.)
  try {
    (SYNC_TRIGGER_SCOPES as Record<string, string>)['order-open'] = 'full';
  } catch { /* frozen: expected */ }
  assert.equal(SYNC_TRIGGER_SCOPES['order-open'], 'pending');
  assert.equal(scopeForSyncTrigger('order-open'), 'pending');
});

test('module is pure: no clock, network, or DB in the source', () => {
  const src = readFileSync(join(HERE, 'lib', 'bfmrSyncTrigger.ts'), 'utf8');
  for (const banned of ['Date.now()', 'fetch(', 'prisma', 'bfmrSyncScope']) {
    assert.ok(!src.includes(banned), `lib/bfmrSyncTrigger.ts must not reference ${banned}`);
  }
});

// --- structural wiring pins (files read as TEXT) ------------------------------

test('route calls resolveBfmrSyncPlan and no longer hard-codes the full status enum', () => {
  const src = readFileSync(ROUTE, 'utf8');
  assert.ok(src.includes('resolveBfmrSyncPlan'), 'route must call resolveBfmrSyncPlan');
  // The inline filter is gone: the 13-value literal may only live in
  // lib/bfmrSyncScope.ts now.
  const FULL_ENUM = 'purchased,reserved,return,payment_error,shipped,processed,set_aside,paid,cancelled,returned,closed,deadline,pkg_received';
  assert.ok(!src.includes(FULL_ENUM), 'route must not build the tracker filter inline');
});

test('linker auto-sync fetch uses the order-open trigger; manual sync does not', () => {
  const src = readFileSync(LINKER, 'utf8');
  // The auto-sync path is entitled to the narrow scope via the trigger literal.
  assert.ok(
    src.includes("trigger: 'order-open'") || src.includes('scopeForSyncTrigger'),
    "linker auto-sync must reference the 'order-open' trigger (or scopeForSyncTrigger)",
  );
  // The MANUAL sync function must NOT carry the order-open trigger -- it keeps
  // the full scope. Find its fetch and assert the trigger literal is absent
  // from that call.
  const manualIdx = src.indexOf('async function sync()');
  assert.ok(manualIdx !== -1, 'linker must still have a manual sync() function');
  const manualFetch = src.slice(manualIdx).split('\n').find(l => l.includes("fetch('/api/bfmr/sync-reservations'"));
  assert.ok(manualFetch !== undefined, 'manual sync must still POST /api/bfmr/sync-reservations');
  assert.ok(!manualFetch!.includes('order-open'), "manual sync must not use the 'order-open' trigger");
});

test('autoSync loopback POST is NOT on the order-open trigger (scheduled keeps full scope)', () => {
  const src = readFileSync(AUTOSYNC, 'utf8');
  const line = src.split('\n').find(l => l.includes("loopbackPost('/api/bfmr/sync-reservations'"));
  assert.ok(line !== undefined, 'autoSync must still loopback-POST /api/bfmr/sync-reservations');
  assert.ok(!line!.includes('order-open'), "scheduled sync must not use the 'order-open' trigger");
});
