/**
 * Regression test for the "BG Credited" flag flipping on a single shipment.
 *
 * The bug: runBgReceiptSync() flipped bgCredited as soon as ANY in-balance
 * receipt matched an order, so order 899 — shipped in 2 packages with only 1
 * credited by the buying group — showed "BG Credited: yes". An order must be
 * BG-credited only when EVERY one of its shipments (tracking numbers) has an
 * in-balance receipt.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { isOrderFullyCredited } from './bgCredited.ts';

test('2 shipments, only 1 credited => NOT credited (the 899 bug)', () => {
  assert.equal(isOrderFullyCredited(['t1', 't2'], new Set(['t1'])), false);
});

test('2 shipments, both credited => credited', () => {
  assert.equal(isOrderFullyCredited(['t1', 't2'], new Set(['t1', 't2'])), true);
});

test('single shipment credited => credited', () => {
  assert.equal(isOrderFullyCredited(['t1'], new Set(['t1'])), true);
});

test('single shipment, none credited => NOT credited', () => {
  assert.equal(isOrderFullyCredited(['t1'], new Set()), false);
});

test('no shipments => NOT credited (nothing to credit)', () => {
  assert.equal(isOrderFullyCredited([], new Set(['t1'])), false);
});

test('3 shipments, 2 credited => NOT credited', () => {
  assert.equal(isOrderFullyCredited(['a', 'b', 'c'], new Set(['a', 'b'])), false);
});

test("another order's credited tracking does not count", () => {
  // Only t2 of this order is credited; t1 is uncredited even though a foreign
  // tracking (x9) sits in the credited set. Must stay NOT credited.
  assert.equal(isOrderFullyCredited(['t1', 't2'], new Set(['t2', 'x9'])), false);
});

test('credited tokens are matched exactly, not by prefix or substring', () => {
  // A different tracking that merely shares a prefix must not satisfy t1.
  assert.equal(isOrderFullyCredited(['t1'], new Set(['t10'])), false);
});
