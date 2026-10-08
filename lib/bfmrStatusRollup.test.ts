import test from 'node:test';
import assert from 'node:assert/strict';
import { rollUpBfmrStatus } from './bfmrStatusRollup.ts';

const SHIPPED = 3, PAID = 5;

test('order 900: both legs paid, order at shipped -> paid', () => {
  assert.equal(rollUpBfmrStatus([5, 5], SHIPPED, SHIPPED, PAID), 'paid');
});
test('one leg still shipped -> shipped at most', () => {
  assert.equal(rollUpBfmrStatus([5, 3], 2, SHIPPED, PAID), 'shipped');
  assert.equal(rollUpBfmrStatus([5, 3], SHIPPED, SHIPPED, PAID), null);
});
test('never demotes, nothing to roll up from no links', () => {
  assert.equal(rollUpBfmrStatus([3], PAID, SHIPPED, PAID), null);
  assert.equal(rollUpBfmrStatus([], 0, SHIPPED, PAID), null);
});
