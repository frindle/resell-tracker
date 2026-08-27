/**
 * Regression test for the "Pending" filter including cancelled orders.
 *
 * The bug: paymentStatus() never checked o.cancelled. A cancelled order
 * with o.buyer still set fell through every earlier check and hit
 * `if (o.buyer) return 'pending'` — so it counted toward pendingCount and
 * matched the Pending filter on app/orders/page.tsx, even though the same
 * row separately renders a "Cancelled" badge from o.cancelled directly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { paymentStatus, fullyReturned, type OrderForPaymentStatus } from './paymentStatus.ts';

function order(overrides: Partial<OrderForPaymentStatus> = {}): OrderForPaymentStatus {
  return {
    lost: false,
    cancelled: false,
    salePriceSynced: false,
    salePrice: null,
    bgPaidAmount: null,
    bgExpectedPayout: null,
    bgCredited: false,
    bfmrStatus: null,
    overdueAt: null,
    buyer: null,
    returns: [],
    commitmentLinks: [],
    bfmrLinks: [],
    ...overrides,
  };
}

test('a cancelled order with a buyer is not "pending"', () => {
  const o = order({ cancelled: true, buyer: { name: 'Some Buyer' } });
  assert.equal(paymentStatus(o), 'none');
});

test('cancelled takes precedence even over an otherwise-paid order', () => {
  // Guards against a future change re-ordering the checks and letting a
  // cancelled-but-paid order read as "paid" instead of being excluded.
  const o = order({ cancelled: true, salePriceSynced: true, buyer: { name: 'Some Buyer' } });
  assert.equal(paymentStatus(o), 'none');
});

test('cancelled takes precedence over lost', () => {
  const o = order({ cancelled: true, lost: true });
  assert.equal(paymentStatus(o), 'none');
});

test('a non-cancelled order with a buyer is still "pending" (unchanged behavior)', () => {
  const o = order({ buyer: { name: 'Some Buyer' } });
  assert.equal(paymentStatus(o), 'pending');
});

test('a non-cancelled lost order is still "lost" (unchanged behavior)', () => {
  const o = order({ lost: true });
  assert.equal(paymentStatus(o), 'lost');
});

test('a non-cancelled synced order is still "paid" (unchanged behavior)', () => {
  const o = order({ salePriceSynced: true });
  assert.equal(paymentStatus(o), 'paid');
});

test('fullyReturned is unaffected by the cancelled check', () => {
  const o = order({ returns: [{ status: 'refunded', quantity: 1 }] });
  assert.equal(fullyReturned(o), true);
});
