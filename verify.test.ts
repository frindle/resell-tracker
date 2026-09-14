// Adversarial repo-style test for: rt-group-address-match (tsx --test, tsconfig @/ paths)
// checkGroupAddressMatch flags whether an order's already-shipped-to (free-text) address
// still matches the NEW group's expected saved address after a move. It NEVER mutates;
// `changeable` says whether the (unshipped) order's Amazon address could still be changed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkGroupAddressMatch } from '@/lib/groupAddressMatch';

const EXP = { line1: '123 Main St', postalCode: '89501' };

test('exact match (line1 + zip present in free text), unshipped => matches, changeable', () => {
  const r = checkGroupAddressMatch('123 Main St, Reno, NV 89501', EXP, { shipped: false });
  assert.equal(r.matches, true);
  assert.equal(r.changeable, true);
});

test('case/whitespace differences still match', () => {
  const r = checkGroupAddressMatch('  123   MAIN st , reno nv  89501 ', EXP, { shipped: false });
  assert.equal(r.matches, true);
});

test('OVER-TRIGGER GUARD: line1 matches but ZIP differs => NOT a match', () => {
  const r = checkGroupAddressMatch('123 Main St, Reno, NV 89502', EXP, { shipped: false });
  assert.equal(r.matches, false);
});

test('OVER-TRIGGER GUARD: zip matches but street differs => NOT a match', () => {
  const r = checkGroupAddressMatch('999 Oak Ave, Reno, NV 89501', EXP, { shipped: false });
  assert.equal(r.matches, false);
});

test('shipped order: changeable is FALSE even when it matches', () => {
  const r = checkGroupAddressMatch('123 Main St, Reno, NV 89501', EXP, { shipped: true });
  assert.equal(r.matches, true);
  assert.equal(r.changeable, false);
});

test('mismatch on an UNSHIPPED order is still changeable (can fix on Amazon)', () => {
  const r = checkGroupAddressMatch('999 Oak Ave, Reno, NV 89502', EXP, { shipped: false });
  assert.equal(r.matches, false);
  assert.equal(r.changeable, true);
});

test('expected has no postalCode: match on line1 alone', () => {
  const r = checkGroupAddressMatch('123 Main St, Reno, NV', { line1: '123 Main St', postalCode: null }, { shipped: false });
  assert.equal(r.matches, true);
});

test('degenerate: null / empty order address does not throw, matches false', () => {
  const r = checkGroupAddressMatch(null, EXP, { shipped: false });
  assert.equal(r.matches, false);
  assert.ok(typeof r.reason === 'string' && r.reason.length > 0);
});
