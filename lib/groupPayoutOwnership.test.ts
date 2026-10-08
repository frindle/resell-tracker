import test from 'node:test';
import assert from 'node:assert/strict';
import { bfmrOwnsPayout, bgReceiptExpectedPayout } from './groupPayoutOwnership.ts';

test('BFMR sync owns payout only for BFMR-assigned or unassigned orders', () => {
  assert.equal(bfmrOwnsPayout('BFMR'), true);
  assert.equal(bfmrOwnsPayout(null), true);
  assert.equal(bfmrOwnsPayout(''), true);
  assert.equal(bfmrOwnsPayout('BuyingGroup'), false);
  assert.equal(bfmrOwnsPayout('BigSkyBuyers'), false);
  assert.equal(bfmrOwnsPayout('CardCenter'), false);
});

const base = { bgExpectedPayout: 531, locked: false, userEditedExpected: false, hasCommitmentLinks: false, fullyCredited: true, inBalanceAmount: 537 };

test('order 952: stale BFMR $531 replaced by BG credited $537', () => {
  assert.equal(bgReceiptExpectedPayout(base), 537);
  assert.equal(bgReceiptExpectedPayout({ ...base, bgExpectedPayout: null }), 537);
});
test('already equal, or nothing credited: no write', () => {
  assert.equal(bgReceiptExpectedPayout({ ...base, bgExpectedPayout: 537 }), undefined);
  assert.equal(bgReceiptExpectedPayout({ ...base, inBalanceAmount: null }), undefined);
  assert.equal(bgReceiptExpectedPayout({ ...base, inBalanceAmount: 0 }), undefined);
  assert.equal(bgReceiptExpectedPayout({ ...base, fullyCredited: false }), undefined);
});
test('commitment-linked, hand-edited, or locked orders keep their expectation', () => {
  assert.equal(bgReceiptExpectedPayout({ ...base, hasCommitmentLinks: true }), undefined);
  assert.equal(bgReceiptExpectedPayout({ ...base, userEditedExpected: true }), undefined);
  assert.equal(bgReceiptExpectedPayout({ ...base, locked: true }), undefined);
});
