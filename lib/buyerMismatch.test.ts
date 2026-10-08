import test from 'node:test';
import assert from 'node:assert/strict';
import { bfmrSyncBuyerMismatch } from './buyerMismatch.ts';

test('BG-assigned order BFMR only "purchased": flag not set, stale flag cleared (order 967)', () => {
  assert.equal(bfmrSyncBuyerMismatch('BuyingGroup', false, false), undefined);
  assert.equal(bfmrSyncBuyerMismatch('BuyingGroup', false, true), false);
});
test('BG-assigned order BFMR received or paid: flagged', () => {
  assert.equal(bfmrSyncBuyerMismatch('BuyingGroup', true, false), true);
  assert.equal(bfmrSyncBuyerMismatch('BigSkyBuyers', true, false), true);
  assert.equal(bfmrSyncBuyerMismatch('Buying Group', true, true), undefined);
});
test('BFMR-assigned or other orders are left to bgSync (never touched here)', () => {
  assert.equal(bfmrSyncBuyerMismatch('BFMR', true, true), undefined);
  assert.equal(bfmrSyncBuyerMismatch('BFMR', false, true), undefined);
  assert.equal(bfmrSyncBuyerMismatch('', true, false), undefined);
});
