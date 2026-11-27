import test from 'node:test';
import assert from 'node:assert/strict';
import { planCarrierChecks, shipDateFor, countQueuedItems, CARRIER_MAX_ATTEMPTS, type CarrierCandidate, type CarrierRowState } from './carrierPlan.ts';

const NOW = new Date('2026-11-26T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const daysAgo = (d: number) => hoursAgo(d * 24);
const cand = (n: string, extra: Partial<CarrierCandidate> = {}): CarrierCandidate =>
  ({ carrier: 'fedex', trackingNumber: n, shippedAt: daysAgo(2), bgBound: true, ...extra });
const row = (n: string, extra: Partial<CarrierRowState> = {}): CarrierRowState =>
  ({ trackingNumber: n, status: 'in_transit', deliveredAt: null, checkedAt: null, attempts: 1, ...extra });
const plan = (candidates: CarrierCandidate[], rows: CarrierRowState[] = [], sentLast24h = 0) =>
  planCarrierChecks({ candidates, rows, sentLast24h, now: NOW }).map(i => i.trackingNumber);

test('picks BG-bound FedEx and UPS numbers only', () => {
  assert.deepEqual(plan([
    cand('A1'), cand('A2', { carrier: 'ups' }), cand('A3', { carrier: 'usps' }),
    cand('A4', { carrier: 'amazon' }), cand('A5', { bgBound: false }),
  ]), ['A1', 'A2']);
});

test('skips delivered, recently checked and exhausted numbers', () => {
  assert.deepEqual(plan(
    [cand('D'), cand('R'), cand('X'), cand('OK'), cand('OLD')],
    [
      row('D', { status: 'delivered', deliveredAt: daysAgo(1) }),
      row('R', { checkedAt: hoursAgo(5) }),
      row('X', { attempts: 8 }),
      row('OK', { checkedAt: hoursAgo(7), attempts: 7 }),
    ],
  ), ['OLD', 'OK']);
});

test('only numbers shipped within 14 days, and never one with no ship date', () => {
  assert.deepEqual(plan([cand('NEW', { shippedAt: daysAgo(13) }), cand('OLD', { shippedAt: daysAgo(15) }), cand('NONE', { shippedAt: null })]), ['NEW']);
});

test('five per run, never-checked first then the longest ago', () => {
  const c = ['N1', 'N2', 'N3', 'N4', 'N5', 'N6'].map(n => cand(n));
  const rows = [row('N1', { checkedAt: hoursAgo(10) }), row('N2', { checkedAt: hoursAgo(20) })];
  assert.deepEqual(plan(c, rows), ['N3', 'N4', 'N5', 'N6', 'N2']);
});

test('the shipping email date wins over the order date', () => {
  const email = new Date('2026-11-20T10:00:00Z');
  const order = new Date('2026-11-01T10:00:00Z');
  assert.equal(shipDateFor(email, order), email);
  assert.equal(shipDateFor(null, order), order);
  assert.equal(shipDateFor(undefined, order), order);
  assert.equal(shipDateFor(new Date('x'), order), order);
  assert.equal(shipDateFor(null, null), null);
});

test('a number shipped inside the window by email is checked even when its order is old', () => {
  const ship = shipDateFor(daysAgo(3), daysAgo(40));
  assert.deepEqual(plan([cand('LATE', { shippedAt: ship })]), ['LATE']);
  assert.deepEqual(plan([cand('OLD', { shippedAt: shipDateFor(null, daysAgo(40)) })]), []);
});

test('a delivered row is never queued again, whatever its source or attempts', () => {
  assert.deepEqual(plan([cand('A'), cand('B')], [
    row('A', { status: 'delivered', deliveredAt: daysAgo(1), attempts: 0 }),
    row('B', { status: 'in_transit', deliveredAt: daysAgo(1), checkedAt: daysAgo(3) }),
  ]), []);
});

test('attempts stop at the limit', () => {
  assert.deepEqual(plan([cand('A')], [row('A', { attempts: CARRIER_MAX_ATTEMPTS - 1, checkedAt: daysAgo(1) })]), ['A']);
  assert.deepEqual(plan([cand('A')], [row('A', { attempts: CARRIER_MAX_ATTEMPTS, checkedAt: daysAgo(1) })]), []);
});

test('queued items are counted from command payloads, rechecks included', () => {
  const p = (n: number) => JSON.stringify({ userId: 1, items: Array.from({ length: n }, (_, i) => ({ carrier: 'ups', trackingNumber: `T${i}` })) });
  assert.equal(countQueuedItems([p(5), p(3), null, 'not json', '{}']), 8);
  assert.equal(countQueuedItems([]), 0);
});

test('twenty per day', () => {
  const c = ['N1', 'N2', 'N3'].map(n => cand(n));
  assert.deepEqual(plan(c, [], 18), ['N1', 'N2']);
  assert.deepEqual(plan(c, [], 20), []);
  assert.deepEqual(plan(c, [], 25), []);
});

test('the same number is listed once, however it is spelled', () => {
  assert.deepEqual(plan([cand('ab 12'), cand('AB12')]), ['ab 12']);
});
