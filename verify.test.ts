// Adversarial repo-style test for: rt-reservation-remaining (tsx --test, tsconfig @/ paths)
// reservationRemaining computes ordered/remaining coverage for a BFMR reservation from its
// links, subtracting per-link CANCELLED and RETURNED units. A cancelled unit must REOPEN
// remaining (it goes back up). Used on group move/re-link and on item-level cancellation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reservationRemaining } from '@/lib/reservationRemaining';

test('no cancels/returns: ordered = sum of quantities, remaining = required - ordered', () => {
  const r = reservationRemaining(5, [{ quantity: 2 }, { quantity: 1 }]);
  assert.equal(r.ordered, 3);
  assert.equal(r.remaining, 2);
  assert.equal(r.overfilled, false);
});

test('exactly filled: remaining 0, not overfilled', () => {
  const r = reservationRemaining(3, [{ quantity: 3 }]);
  assert.equal(r.remaining, 0);
  assert.equal(r.overfilled, false);
});

test('REOPEN: cancelling a unit RAISES remaining vs the same order uncancelled', () => {
  const before = reservationRemaining(3, [{ quantity: 3 }]);
  const after = reservationRemaining(3, [{ quantity: 3, cancelledQty: 1 }]);
  assert.equal(before.remaining, 0);
  assert.equal(after.remaining, 1);   // one unit cancelled -> reservation reopens by 1
  assert.equal(after.ordered, 2);
});

test('returned units also reduce ordered', () => {
  const r = reservationRemaining(4, [{ quantity: 3, returnedQty: 1 }]);
  assert.equal(r.ordered, 2);
  assert.equal(r.remaining, 2);
});

test('cancelled + returned on one link both subtract', () => {
  const r = reservationRemaining(5, [{ quantity: 4, cancelledQty: 1, returnedQty: 1 }]);
  assert.equal(r.ordered, 2);
  assert.equal(r.remaining, 3);
});

test('OVER-TRIGGER GUARD: a link cancelled/returned below zero floors the link at 0, not negative', () => {
  const r = reservationRemaining(5, [{ quantity: 2, cancelledQty: 5 }]);
  assert.equal(r.ordered, 0);         // max(0, 2-5) = 0, never -3
  assert.equal(r.remaining, 5);
});

test('overfilled: ordered exceeds required -> overfilled true, remaining floored at 0', () => {
  const r = reservationRemaining(2, [{ quantity: 3 }]);
  assert.equal(r.overfilled, true);
  assert.equal(r.remaining, 0);       // never negative
  assert.equal(r.ordered, 3);
});

test('degenerate: no links -> ordered 0, remaining = required', () => {
  const r = reservationRemaining(4, []);
  assert.equal(r.ordered, 0);
  assert.equal(r.remaining, 4);
});
