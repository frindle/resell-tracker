import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planWalmartRechecks, recheckOrdersOf, DELIVERY_RECHECK_PURPOSE, RECHECK_MAX_PER_RUN, RECHECK_MAX_READS, RECHECK_MAX_PER_DAY,
  type RecheckOrder, type RecheckHistory,
} from './walmartDeliveryRecheck.ts';

// All numbers below are made up.
const NOW = new Date('2026-11-28T20:00:00Z');
const H = 60 * 60 * 1000;
const ago = (h: number) => new Date(NOW.getTime() - h * H);
const order = (n: string, placedHoursAgo: number, tracking: string | null = `TRK${n}`, hasDeliveryPhoto = true): RecheckOrder =>
  ({ orderNumber: n, orderDate: ago(placedHoursAgo), trackingNumbers: tracking, hasDeliveryPhoto });
const plan = (orders: RecheckOrder[], history: RecheckHistory[] = [], delivered: string[] = []) =>
  planWalmartRechecks({ orders, deliveredNumbers: new Set(delivered), history, now: NOW });

test('a shipped order with no delivered date, inside the window, is re-read', () => {
  assert.deepEqual(plan([order('2000000000001', 48)]), ['2000000000001']);
});

test('too new, too old, no tracking, or already delivered is not re-read', () => {
  assert.deepEqual(plan([order('1', 6), order('2', 15 * 24), order('3', 48, null), order('4', 48, ' ')]), []);
  assert.deepEqual(plan([order('5', 48)], [], ['TRK5']), []);
  // Partly delivered: still re-read.
  assert.deepEqual(plan([order('6', 48, 'TRK6A, trk6b')], [], ['TRK6A']), ['6']);
  assert.deepEqual(plan([order('7', 48, 'TRK7A,TRK7B')], [], ['TRK7A', 'TRK7B']), []);
});

test('an order is re-read at most every 12 hours and at most six times', () => {
  const o = order('9', 100);
  assert.deepEqual(plan([o], [{ createdAt: ago(3), orderNumbers: ['9'] }]), []);
  assert.deepEqual(plan([o], [{ createdAt: ago(13), orderNumbers: ['9'] }]), ['9']);
  const many = Array.from({ length: RECHECK_MAX_READS }, (_, i) => ({ createdAt: ago(13 + i * 13), orderNumbers: ['9'] }));
  assert.deepEqual(plan([o], many), []);
});

test('a delivered order with no delivery photo is still read, once it has the photo it is not', () => {
  assert.deepEqual(plan([order('5', 48, 'TRK5', false)], [], ['TRK5']), ['5']);
  assert.deepEqual(plan([order('5', 48, 'TRK5', true)], [], ['TRK5']), []);
  // Photo but a number not delivered yet: still read.
  assert.deepEqual(plan([order('6', 48, 'TRK6A,TRK6B', true)], [], ['TRK6A']), ['6']);
});

test('FedEx and UPS numbers do not count toward "every number delivered"', () => {
  const ups = '1Z999AA10123456784';
  assert.deepEqual(plan([order('8', 48, `TRK8,${ups}`)], [], ['TRK8']), []);
  assert.deepEqual(plan([order('8', 48, `TRK8,${ups}`, false)], [], ['TRK8']), ['8']);
  // Only a UPS number: nothing for the Walmart page to wait on.
  assert.deepEqual(plan([order('10', 48, ups, false)]), []);
  assert.deepEqual(plan([order('11', 48, `TRK11,${ups}`)], [], [ups]), ['11']);
});

test('the gaps between reads grow so six reads span about two weeks', () => {
  const o = order('9', 14 * 24 - 1);
  const reads = (n: number, lastAgoH: number) =>
    Array.from({ length: n }, (_, i) => ({ createdAt: ago(lastAgoH + i * 1000), orderNumbers: ['9'] }));
  // After read 1 wait 12h, after 2 wait 24h, after 3 wait 48h, after 4 wait 96h, after 5 wait 132h.
  const gaps = [12, 24, 48, 96, 132];
  gaps.forEach((g, i) => {
    assert.deepEqual(plan([o], reads(i + 1, g - 1)), [], `after read ${i + 1}, ${g - 1}h is too soon`);
    assert.deepEqual(plan([o], reads(i + 1, g + 1)), ['9'], `after read ${i + 1}, ${g + 1}h is enough`);
  });
  assert.equal(gaps.reduce((a, b) => a + b, 0) + 12 >= 13 * 24, true);
});

test('never-read orders go first, then the longest since read, capped per run', () => {
  const orders = Array.from({ length: 8 }, (_, i) => order(String(100 + i), 48));
  const history = [{ createdAt: ago(20), orderNumbers: ['100'] }, { createdAt: ago(30), orderNumbers: ['101'] }];
  const picked = plan(orders, history);
  assert.equal(picked.length, RECHECK_MAX_PER_RUN);
  assert.ok(!picked.includes('100') && !picked.includes('101'));
  const later = plan(orders.slice(0, 2), history);
  assert.deepEqual(later, ['101', '100']);
});

test('the day cap counts every order re-read in the last 24 hours', () => {
  const history = [{ createdAt: ago(2), orderNumbers: Array.from({ length: RECHECK_MAX_PER_DAY - 2 }, (_, i) => `x${i}`) }];
  assert.equal(plan([order('1', 48), order('2', 48), order('3', 48)], history).length, 2);
  const full = [{ createdAt: ago(2), orderNumbers: Array.from({ length: RECHECK_MAX_PER_DAY }, (_, i) => `x${i}`) }];
  assert.deepEqual(plan([order('1', 48)], full), []);
});

test('order numbers are compared as digits, and a repeat order is planned once', () => {
  assert.deepEqual(plan([order('2000-0000-0001', 48), order('20000000-0001', 48)]), ['200000000001']);
  assert.deepEqual(plan([order('2000-0000-0001', 48)], [{ createdAt: ago(1), orderNumbers: ['200000000001'] }]), []);
});

test('only re-read commands count as history', () => {
  assert.deepEqual(recheckOrdersOf(JSON.stringify({ orderNumbers: ['2000-01', 7], userId: 1, purpose: DELIVERY_RECHECK_PURPOSE })), ['200001', '7']);
  assert.deepEqual(recheckOrdersOf(JSON.stringify({ orderNumbers: ['1'], userId: 1 })), []);
  assert.deepEqual(recheckOrdersOf('not json'), []);
  assert.deepEqual(recheckOrdersOf(null), []);
});
