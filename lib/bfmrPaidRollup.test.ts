/**
 * Regression test for order 900 reading as fully paid on a PARTIAL split payment.
 *
 * The bug: sync-orders derived isPaid from the MOST-ADVANCED item, so a split
 * BFMR shipment with one paid leg ($1893) and one still-shipped leg ($631) read
 * isPaid=true, then locked the order and wrote bgPaidAmount = the FULL $2524.
 *
 * computeBfmrPaidRollup(activeItems, isPaid, payoutOf) must instead report:
 *   allPaid     = true ONLY when EVERY active item is paid,
 *   paidPayout  = sum of payouts over ONLY the paid items,
 *   totalPayout = sum over all active items (unchanged expectation).
 * The caller gates locked/salePriceSynced on allPaid and writes
 * bgPaidAmount = paidPayout.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { computeBfmrPaidRollup } from './bfmr.ts';

type Item = { paid: boolean; payout: number | null };
const isPaid = (i: Item) => i.paid;
const payoutOf = (i: Item) => i.payout;
const roll = (items: Item[]) => computeBfmrPaidRollup(items, isPaid, payoutOf);

test('THE 900 BUG: one paid + one shipped leg => NOT allPaid, paidPayout is the paid leg only', () => {
  const r = roll([{ paid: true, payout: 1893 }, { paid: false, payout: 631 }]);
  assert.equal(r.allPaid, false);
  assert.equal(r.paidPayout, 1893);   // NOT the inflated 2524
  assert.equal(r.totalPayout, 2524);  // expectation still reflects both legs
});

test('all legs paid => allPaid, paidPayout == totalPayout', () => {
  const r = roll([{ paid: true, payout: 1893 }, { paid: true, payout: 631 }]);
  assert.equal(r.allPaid, true);
  assert.equal(r.paidPayout, 2524);
  assert.equal(r.totalPayout, 2524);
});

test('no legs paid => NOT allPaid, paidPayout 0, totalPayout full', () => {
  const r = roll([{ paid: false, payout: 1893 }, { paid: false, payout: 631 }]);
  assert.equal(r.allPaid, false);
  assert.equal(r.paidPayout, 0);
  assert.equal(r.totalPayout, 2524);
});

test('single paid leg (non-split) => allPaid, both sums equal', () => {
  const r = roll([{ paid: true, payout: 1893 }]);
  assert.equal(r.allPaid, true);
  assert.equal(r.paidPayout, 1893);
  assert.equal(r.totalPayout, 1893);
});

test('empty active set => NOT allPaid, null sums (caller must not lock/write on nothing)', () => {
  const r = roll([]);
  assert.equal(r.allPaid, false);
  assert.equal(r.paidPayout, null);
  assert.equal(r.totalPayout, null);
});

test('null payout on a leg counts as 0, does not corrupt the sums', () => {
  const r = roll([{ paid: true, payout: null }, { paid: true, payout: 100 }]);
  assert.equal(r.allPaid, true);
  assert.equal(r.paidPayout, 100);
  assert.equal(r.totalPayout, 100);
});

test('three legs, two paid => NOT allPaid, paidPayout excludes the unpaid leg', () => {
  const r = roll([
    { paid: true, payout: 500 },
    { paid: true, payout: 300 },
    { paid: false, payout: 200 },
  ]);
  assert.equal(r.allPaid, false);
  assert.equal(r.paidPayout, 800);
  assert.equal(r.totalPayout, 1000);
});
