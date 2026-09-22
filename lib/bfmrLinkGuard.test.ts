// Regression tests for the CROSS-ORDER link guard (orders 219 / 634 / 759,
// confirmed live 2026-09-22).
//
//   npm run test:bfmr-link-guard
//
// No test framework is installed in this repo, so these run on Node's built-in
// runner with type stripping - same convention as the other lib/*.test.ts.
//
// The defect: a reservation attaches to an order purely because they share a
// tracking number. Amazon consolidates boxes from DIFFERENT orders under one
// tracking number, so order 219 (AirPods Pro 3) picked up reservation 103,
// whose own bfmrOrderId names an Apple Watch order that is not even in the DB.
// guardLink now refuses a link whose reservation NAMES a different order - and
// only then: an absent or too-short number on either side is UNKNOWN, which
// must stay linkable (legacy reservations carry no number, and seven live
// orders carry 'N/A' or nothing).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  guardLink,
  orderNumbersAgree,
  reservationContradictsOrder,
} from './bfmrLinkGuard.ts';

// --- orderNumbersAgree: the digit-normalized bidirectional 7-digit-floor match ---

test('orderNumbersAgree: same number in different formats agrees', () => {
  assert.equal(orderNumbersAgree('112-2600594-9517060', '1122600594 9517060'), true);
  assert.equal(orderNumbersAgree('200014751761859', '200014751761859'), true);
});

test('orderNumbersAgree: different orders do not agree; null/short sides are false', () => {
  assert.equal(orderNumbersAgree('112-2600594-9517060', '112-8973564-0951402'), false);
  assert.equal(orderNumbersAgree(null, '112-2600594-9517060'), false);
  assert.equal(orderNumbersAgree('112-2600594-9517060', undefined), false);
  // Under the 7-digit floor even an exact match is not a match.
  assert.equal(orderNumbersAgree('12345', '12345'), false);
});

test('orderNumbersAgree: bidirectional containment (truncated/padded BFMR form)', () => {
  // Shorter side contained in the longer one, either direction.
  assert.equal(orderNumbersAgree('112-2600594', '112-2600594-9517060'), true);
  assert.equal(orderNumbersAgree('112-2600594-9517060', '112-2600594'), true);
});

// --- reservationContradictsOrder: UNKNOWN is never a contradiction ---

test('reservationContradictsOrder: different order contradicts; same order does not', () => {
  assert.equal(
    reservationContradictsOrder('112-8973564-0951402', '112-2600594-9517060'),
    true,
  );
  assert.equal(
    reservationContradictsOrder('112-2600594-9517060', '112-2600594-9517060'),
    false,
  );
});

test('reservationContradictsOrder: null/undefined/empty/too-short is UNKNOWN -> false', () => {
  assert.equal(reservationContradictsOrder(null, '112-2600594-9517060'), false);
  assert.equal(reservationContradictsOrder(undefined, '112-2600594-9517060'), false);
  assert.equal(reservationContradictsOrder('', '112-2600594-9517060'), false);
  // Too-short reservation number: legacy row, not a mismatch.
  assert.equal(reservationContradictsOrder('12345', '112-2600594-9517060'), false);
});

test('reservationContradictsOrder: unknown on the ORDER side is UNKNOWN too', () => {
  // Seven live orders (915, 698, 656, 417, 416, 415, 413) have 'N/A' or no
  // order number at all. A reservation that DOES name an order must still be
  // linkable to them: there is nothing to contradict.
  assert.equal(reservationContradictsOrder('112-8973564-0951402', 'N/A'), false);
  assert.equal(reservationContradictsOrder('112-8973564-0951402', null), false);
  assert.equal(reservationContradictsOrder('112-8973564-0951402', ''), false);
  assert.equal(reservationContradictsOrder('112-8973564-0951402', '12345'), false);
});

// --- guardLink: the third invariant, checked FIRST for the right reason ---

test('guardLink: live incident — reservation 103 (order 112-8973564-0951402) rejected on order 219', () => {
  const res = guardLink([], {
    orderId: 219,
    reservationId: 103,
    quantity: 3,
    trackingNumber: 'TBA327676654858',
    reservationQty: 3,
    reservationBfmrOrderId: '112-8973564-0951402',
    orderNumber: '112-2600594-9517060',
  });
  assert.equal(res.ok, false);
  if (res.ok) throw new Error('unreachable');
  // The reason must name BOTH order numbers.
  assert.match(res.reason, /112-8973564-0951402/);
  assert.match(res.reason, /112-2600594-9517060/);
});

test('guardLink: contradiction is rejected BEFORE duplicate-tracking (right reason)', () => {
  // A same-reservation duplicate tracking link already exists; without the new
  // invariant this would be a "duplicate tracking" rejection. With it, the
  // cross-order contradiction must win and name both order numbers.
  const res = guardLink(
    [{ id: 69, reservationId: 103, quantity: 0, trackingNumber: 'TBA327676654858' }],
    {
      orderId: 219,
      reservationId: 103,
      quantity: 3,
      trackingNumber: 'tba327676654858',
      reservationQty: 3,
      reservationBfmrOrderId: '112-8973564-0951402',
      orderNumber: '112-2600594-9517060',
    },
  );
  assert.equal(res.ok, false);
  if (res.ok) throw new Error('unreachable');
  assert.match(res.reason, /belongs to BFMR order/);
  assert.doesNotMatch(res.reason, /^duplicate tracking/);
});

test('guardLink: UNKNOWN bfmrOrderId stays legal — legacy links unaffected', () => {
  // Orders 634/646/649/759/919 hold links whose reservations have no captured
  // bfmrOrderId; those must keep linking exactly as before.
  for (const unknown of [undefined, null, '']) {
    const res = guardLink([], {
      orderId: 634,
      reservationId: 501,
      quantity: 2,
      trackingNumber: 'TBA1',
      reservationQty: 2,
      reservationBfmrOrderId: unknown as string | null | undefined,
      orderNumber: '112-2600594-9517060',
    });
    assert.equal(res.ok, true, `unknown bfmrOrderId ${String(unknown)} must not contradict`);
  }
});

test('guardLink: OVER-TRIGGER GUARD — order 929 same-order twins sharing one tracking stay legal', () => {
  // Reservations 307956 and 307955 both carry bfmrOrderId 111-8254681-0840266,
  // which IS order 929's number. Both links must stay legal even though they
  // share one tracking number (per-reservation scoping of the duplicate check).
  const links = [
    { id: 700, reservationId: 307956, quantity: 1, trackingNumber: 'TBA929' },
  ];
  const res = guardLink(links, {
    orderId: 929,
    reservationId: 307955,
    quantity: 1,
    trackingNumber: 'TBA929',
    reservationQty: 1,
    reservationBfmrOrderId: '111-8254681-0840266',
    orderNumber: '111-8254681-0840266',
  });
  assert.equal(res.ok, true);

  // And the same-order reservation still gets its duplicate-tracking rejection.
  const dup = guardLink(links, {
    orderId: 929,
    reservationId: 307956,
    quantity: 1,
    trackingNumber: 'TBA929',
    reservationQty: 1,
    reservationBfmrOrderId: '111-8254681-0840266',
    orderNumber: '111-8254681-0840266',
  });
  assert.equal(dup.ok, false);
});

test('guardLink: omitting the optional fields behaves exactly as before (no regression)', () => {
  // Existing call sites pass neither field: a cross-order reservation with no
  // params is still permitted today's way — the guard only fires when told.
  const res = guardLink([], {
    orderId: 219,
    reservationId: 103,
    quantity: 3,
    trackingNumber: 'TBA327676654858',
    reservationQty: 3,
  });
  assert.equal(res.ok, true);

  // And the pre-existing invariants still fire when params are absent.
  const dup = guardLink(
    [{ id: 1, reservationId: 7, quantity: 2, trackingNumber: 'TBA1' }],
    { orderId: 5, reservationId: 7, quantity: 1, trackingNumber: 'tba1', reservationQty: 3 },
  );
  assert.equal(dup.ok, false);

  const over = guardLink(
    [{ id: 1, reservationId: 7, quantity: 2, trackingNumber: null }],
    { orderId: 5, reservationId: 7, quantity: 2, trackingNumber: 'TBA2', reservationQty: 3 },
  );
  assert.equal(over.ok, false);
});
