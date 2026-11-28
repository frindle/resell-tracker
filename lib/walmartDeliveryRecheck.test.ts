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
const order = (n: string, placedHoursAgo: number, tracking: string | null = `TRK${n}`): RecheckOrder =>
  ({ orderNumber: n, orderDate: ago(placedHoursAgo), trackingNumbers: tracking });
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
