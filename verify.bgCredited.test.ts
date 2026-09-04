/**
 * GATE (harness-owned, do not edit): an order is BG-credited ONLY when EVERY
 * one of its shipments has an in-balance receipt. The reported bug: order 899
 * had 2 shipments, 1 credited, yet showed "BG Credited: yes". The fix must make
 * the ANY→ALL decision a pure, testable function with this exact signature:
 *   export function isOrderFullyCredited(
 *     orderTrackings: string[], creditedTrackings: Set<string>): boolean
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isOrderFullyCredited } from './lib/bgCredited.ts';

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
  // only t2 of this order is credited; t1 uncredited even though a foreign
  // tracking (x9) is in the credited set. Must stay NOT credited.
  assert.equal(isOrderFullyCredited(['t1', 't2'], new Set(['t2', 'x9'])), false);
});
