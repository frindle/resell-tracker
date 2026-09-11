// Adversarial repo-style test for: bfmr-cap-link-to-reservation   (tsx --test; repo uses @/ paths)
//
// Property under test: capLinkToReservation(link, reservation) caps a link so it
// can never claim more QUANTITY than its reservation's current qty, nor more
// VALUE than expectedLinkValue(reservation.totalPayout, reservation.qty, cappedQty).
// It returns the adjusted {quantity, value} ONLY when the link over-allocates,
// else null. It must never RAISE an under-allocated link, and must never throw
// on null value / null totalPayout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capLinkToReservation } from '@/lib/bfmrAutoLink';

test('order-768 boundary: over by qty and value is capped to the reservation share', () => {
  // link 97 (qty2/value598) vs reservation 6481 (qty1/payout299) -> {1,299}
  assert.deepEqual(
    capLinkToReservation({ quantity: 2, value: 598 }, { qty: 1, totalPayout: 299 }),
    { quantity: 1, value: 299 },
  );
});

test('OVER-TRIGGER GUARD: an exactly-correct link does NOT fire (returns null)', () => {
  assert.equal(
    capLinkToReservation({ quantity: 1, value: 299 }, { qty: 1, totalPayout: 299 }),
    null,
  );
});

test('OVER-TRIGGER GUARD: an under-allocated (hand-lowered) link is left alone, never inflated', () => {
  // 250 < the 299 share -> no change, and must NOT be raised to 299
  assert.equal(
    capLinkToReservation({ quantity: 1, value: 250 }, { qty: 1, totalPayout: 299 }),
    null,
  );
});

test('WRONG-FIX CATCHER: value over but qty equal must still cap the value', () => {
  // A fix that only checks quantity returns null here and fails this case.
  assert.deepEqual(
    capLinkToReservation({ quantity: 1, value: 598 }, { qty: 1, totalPayout: 299 }),
    { quantity: 1, value: 299 },
  );
});

test('multi-unit shrink: qty 3/value 900 vs reservation qty 2/payout 600 -> {2,600}', () => {
  assert.deepEqual(
    capLinkToReservation({ quantity: 3, value: 900 }, { qty: 2, totalPayout: 600 }),
    { quantity: 2, value: 600 },
  );
});

test('degenerate: null link value with over-qty caps qty and fills the computed share', () => {
  assert.deepEqual(
    capLinkToReservation({ quantity: 2, value: null }, { qty: 1, totalPayout: 299 }),
    { quantity: 1, value: 299 },
  );
});

test('degenerate: null totalPayout does not throw; caps qty, leaves value untouched', () => {
  assert.deepEqual(
    capLinkToReservation({ quantity: 2, value: 598 }, { qty: 1, totalPayout: null }),
    { quantity: 1, value: 598 },
  );
});

test('rounding: 599 over the 299 share collapses to the exact share, not 599', () => {
  assert.deepEqual(
    capLinkToReservation({ quantity: 2, value: 599 }, { qty: 1, totalPayout: 299 }),
    { quantity: 1, value: 299 },
  );
});
