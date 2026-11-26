import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeHours, parseState, planCostcoAutoSync, EMPTY_STATE, DEFAULT_HOURS, MAX_HOURS, RUNNING_STALE_MS, PENDING_STALE_MS,
  type CostcoRow,
} from './costcoAutoSync.ts';
import { isSignInNeededResult, costcoAutoSyncLine } from './syncStatus.ts';

const H = 3_600_000;
const MIN = 60_000;
const NOW = Date.UTC(2030, 0, 15, 12, 0, 0);
const row = (o: Partial<CostcoRow> = {}): CostcoRow => ({ type: 'SYNC_COSTCO', status: 'done', result: '{"imported":1}', updatedAt: NOW - 7 * H, ...o });
const plan = (rows: CostcoRow[], extra: { hours?: number; state?: ReturnType<typeof parseState>; now?: number; rand?: () => number } = {}) =>
  planCostcoAutoSync({ now: extra.now ?? NOW, hours: extra.hours ?? 6, rows, state: extra.state ?? EMPTY_STATE, rand: extra.rand ?? (() => 0) });

test('sanitizeHours: blank and junk give the default, 0 is off, big values are capped', () => {
  assert.equal(sanitizeHours(undefined), DEFAULT_HOURS);
  assert.equal(sanitizeHours(''), DEFAULT_HOURS);
  assert.equal(sanitizeHours('abc'), DEFAULT_HOURS);
  assert.equal(sanitizeHours('-3'), DEFAULT_HOURS);
  assert.equal(sanitizeHours('0'), 0);
  assert.equal(sanitizeHours('4.7'), 4);
  assert.equal(sanitizeHours('9999'), MAX_HOURS);
});

test('parseState: garbage becomes the empty state', () => {
  assert.deepEqual(parseState('nope'), EMPTY_STATE);
  assert.deepEqual(parseState(null), EMPTY_STATE);
  assert.deepEqual(parseState('{"dueAt":5,"basis":"x"}'), { dueAt: 5, basis: 'x' });
});

test('first ever run is scheduled a few minutes out, not at once', () => {
  const p = plan([]);
  assert.equal(p.queue, false);
  assert.equal(p.nextAt, NOW + 3 * MIN);
});

test('queues once the interval and the delay have passed', () => {
  const first = plan([row({ updatedAt: NOW - 6 * H })]);
  assert.equal(first.queue, false);
  const later = plan([row({ updatedAt: NOW - 6 * H })], { state: first.state, now: first.nextAt! });
  assert.equal(later.queue, true);
  assert.deepEqual(later.state, EMPTY_STATE);
});

test('the delay stays the same between polls', () => {
  const rows = [row({ updatedAt: NOW - 6 * H })];
  const a = plan(rows, { rand: () => 0.5 });
  const b = plan(rows, { state: a.state, now: NOW + MIN, rand: () => 0.99 });
  assert.equal(b.nextAt, a.nextAt);
});

test('the delay is never zero, so it never lands exactly on the due time', () => {
  const p = plan([row({ updatedAt: NOW - 6 * H })], { rand: () => 0 });
  assert.ok(p.nextAt! - NOW >= 3 * MIN);
});

test('recent sync: waits for the rest of the interval', () => {
  const p = plan([row({ updatedAt: NOW - 1 * H })]);
  assert.equal(p.queue, false);
  assert.equal(p.nextAt, NOW - 1 * H + 6 * H + 3 * MIN);
});

test('a pending or fresh running Costco command blocks it, for either Costco type', () => {
  for (const status of ['pending', 'running']) {
    for (const type of ['SYNC_COSTCO', 'SYNC_COSTCO_ORDER']) {
      const p = plan([row(), { type, status, result: null, updatedAt: NOW - MIN }], { now: NOW });
      assert.equal(p.queue, false);
      assert.equal(p.inFlight, true);
    }
  }
});

test('an old pending SYNC_COSTCO still blocks a new one and reads as waiting for the browser', () => {
  const old = { type: 'SYNC_COSTCO', status: 'pending', result: null, updatedAt: NOW - 30 * H };
  const p = plan([row({ updatedAt: NOW - 40 * H }), old], { state: { dueAt: NOW - H, basis: `${NOW - 40 * H}:${6 * H}` } });
  assert.equal(p.queue, false);
  assert.equal(p.inFlight, true);
  assert.equal(p.waitingForBrowser, true);
  const fresh = plan([row(), { ...old, updatedAt: NOW - PENDING_STALE_MS + MIN }]);
  assert.equal(fresh.inFlight, true);
  assert.equal(fresh.waitingForBrowser, false);
});

test('a per-order command nobody claimed for an hour does not block it', () => {
  const stale = { type: 'SYNC_COSTCO_ORDER', status: 'pending', result: null, updatedAt: NOW - PENDING_STALE_MS - MIN };
  assert.equal(plan([row(), stale]).inFlight, false);
  assert.equal(plan([row(), { ...stale, updatedAt: NOW - PENDING_STALE_MS + MIN }]).inFlight, true);
});

test('a running command that went quiet is treated as dead', () => {
  const p = plan([row(), row({ status: 'running', result: null, updatedAt: NOW - RUNNING_STALE_MS - MIN })]);
  assert.equal(p.inFlight, false);
});

test('other platforms do not block it', () => {
  const p = plan([row(), { type: 'SYNC_WALMART', status: 'pending', result: null, updatedAt: NOW }]);
  assert.equal(p.inFlight, false);
});

test('after a sign-in-needed failure it waits a day', () => {
  const failed = row({ status: 'failed', result: JSON.stringify({ error: 'Costco sign-in needed - sign in to costco.com in this browser' }), updatedAt: NOW - 7 * H });
  const p = plan([failed]);
  assert.equal(p.signInNeeded, true);
  assert.equal(p.queue, false);
  assert.equal(p.nextAt, NOW - 7 * H + 24 * H + 3 * MIN);
});

test('an ordinary failure does not back off to a day', () => {
  const failed = row({ status: 'failed', result: '{"error":"timed out"}', updatedAt: NOW - 7 * H });
  const p = plan([failed], { state: EMPTY_STATE });
  assert.equal(p.signInNeeded, false);
  assert.equal(p.nextAt, NOW + 3 * MIN);
});

test('a good sync after the sign-in failure ends the back-off', () => {
  const failed = row({ status: 'failed', result: '{"error":"Costco sign-in needed - x"}', updatedAt: NOW - 30 * H });
  const ok = row({ updatedAt: NOW - 7 * H });
  assert.equal(plan([failed, ok]).signInNeeded, false);
});

test('an interval of 0 turns it off', () => {
  const p = plan([], { hours: 0 });
  assert.equal(p.queue, false);
  assert.equal(p.enabled, false);
});

test('a stale saved delay (from before the last sync) is recomputed', () => {
  const p = plan([row({ updatedAt: NOW - 1 * H })], { state: { dueAt: NOW - 5 * H, basis: 'old:1' } });
  assert.equal(p.queue, false);
});

test('isSignInNeededResult reads plain and JSON results only for the sign-in message', () => {
  assert.equal(isSignInNeededResult('{"error":"Costco sign-in needed - sign in to costco.com in this browser"}'), true);
  assert.equal(isSignInNeededResult('Costco sign-in needed'), true);
  assert.equal(isSignInNeededResult('{"error":"timed out"}'), false);
  assert.equal(isSignInNeededResult(null), false);
});

test('costcoAutoSyncLine covers off, running, sign-in, and scheduled', () => {
  const base = { enabled: true, hours: 6, inFlight: false, signInNeeded: false, lastAt: NOW - 2 * H, nextAt: NOW + 30 * MIN };
  assert.match(costcoAutoSyncLine({ ...base, enabled: false }, NOW), /off/);
  assert.match(costcoAutoSyncLine({ ...base, inFlight: true }, NOW), /running now/);
  assert.match(costcoAutoSyncLine({ ...base, inFlight: true, waitingForBrowser: true }, NOW), /waiting for the browser/);
  assert.match(costcoAutoSyncLine({ ...base, signInNeeded: true }, NOW), /sign in/);
  assert.match(costcoAutoSyncLine(base, NOW), /every 6h, last 2h ago, next in 30m/);
  assert.match(costcoAutoSyncLine({ ...base, lastAt: null, nextAt: null }, NOW), /not run yet/);
});
