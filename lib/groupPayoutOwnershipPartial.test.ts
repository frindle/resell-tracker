import test from 'node:test';
import assert from 'node:assert/strict';
import { bgReceiptExpectedPayout } from './groupPayoutOwnership.ts';

test('partial receipt (salePrice set, inBalanceAmount < salePrice - threshold) returns undefined', () => {
  // Order 975: 3 units, salePrice 899.91, only 2 packages credited → inBalanceAmount 599.94
  // 599.94 < 899.91 - max(1, 899.91 * 0.01) = 899.91 - 8.9991 = 890.9109
  const result = bgReceiptExpectedPayout({
    bgExpectedPayout: null,
    locked: false,
    userEditedExpected: false,
    hasCommitmentLinks: false,
    fullyCredited: true,
    inBalanceAmount: 599.94,
    salePrice: 899.91,
  });
  assert.equal(result, undefined);
});

test('when salePrice is null, behaves as before (returns inBalanceAmount)', () => {
  const result = bgReceiptExpectedPayout({
    bgExpectedPayout: null,
    locked: false,
    userEditedExpected: false,
    hasCommitmentLinks: false,
    fullyCredited: true,
    inBalanceAmount: 599.94,
  });
  assert.equal(result, 599.94);
});

test('full receipt within tolerance of salePrice is still adopted', () => {
  // 895 >= 899.91 - 8.9991, so not partial
  const result = bgReceiptExpectedPayout({
    bgExpectedPayout: null,
    locked: false,
    userEditedExpected: false,
    hasCommitmentLinks: false,
    fullyCredited: true,
    inBalanceAmount: 895,
    salePrice: 899.91,
  });
  assert.equal(result, 895);
});

test('salePrice 0 behaves as before (adopts inBalanceAmount)', () => {
  const result = bgReceiptExpectedPayout({
    bgExpectedPayout: null,
    locked: false,
    userEditedExpected: false,
    hasCommitmentLinks: false,
    fullyCredited: true,
    inBalanceAmount: 599.94,
    salePrice: 0,
  });
  assert.equal(result, 599.94);
});
