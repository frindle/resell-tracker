/**
 * Tests for the BFMR order-number push decision.
 *
 *   npm run test:bfmr-push-gate
 *
 * No test framework is installed in this repo, so these run on Node's built-in
 * runner with type stripping.
 *
 * The cases that matter are the two failure modes on either side of the
 * decision, because both are silent and both cost real money:
 *   - not pushing when we should: BFMR never learns the order number
 *   - pushing when we should not: the same order number is sent twice
 * A rule that only avoids one of those is not a fix.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldPushOrderNumber, isPartialLink, type PushGateInput } from './bfmrPushGate.ts';

function input(over: Partial<PushGateInput> = {}): PushGateInput {
  return {
    orderNumber: '111-4675771-1713018',
    myTrackerId: 4242,
    reservationBfmrOrderId: null,
    quantity: 2,
    reservationQty: 2,
    ...over,
  };
}

test('a first full link pushes', () => {
  const d = shouldPushOrderNumber(input());
  assert.equal(d.push, true);
  assert.equal(d.push === true && d.partial, false);
});

test('adjusting an existing link still pushes', () => {
  // The flow that never worked: link, then change the qty on the row. The
  // reservation has no order number yet, so BFMR still needs to be told.
  const d = shouldPushOrderNumber(input({ quantity: 1, reservationQty: 2, reservationBfmrOrderId: null }));
  assert.equal(d.push, true, 'a qty change on an already-linked reservation must still push');
});

test('the same order number is never sent twice', () => {
  const d = shouldPushOrderNumber(input({ reservationBfmrOrderId: '111-4675771-1713018' }));
  assert.equal(d.push, false);
  assert.match(d.push === false ? d.reason : '', /already carries this order number/);
});

test('a different order number on the reservation still pushes', () => {
  // The split case: the remainder legitimately gets its own second order
  // number, and refusing here would strand it forever.
  const d = shouldPushOrderNumber(input({
    reservationBfmrOrderId: '111-0000000-0000000',
    quantity: 3,
    reservationQty: 5,
  }));
  assert.equal(d.push, true);
  assert.equal(d.push === true && d.partial, true);
});

test('no order number means nothing to push', () => {
  const d = shouldPushOrderNumber(input({ orderNumber: null }));
  assert.equal(d.push, false);
  assert.match(d.push === false ? d.reason : '', /order number/);
});

test('a missing tracker id is reported, not silently skipped', () => {
  const d = shouldPushOrderNumber(input({ myTrackerId: null }));
  assert.equal(d.push, false);
  assert.match(d.push === false ? d.reason : '', /myTrackerId/);
  assert.ok((d.push === false ? d.reason : '').length > 0, 'the reason must be reportable to the user');
});

test('a missing tracker id outranks an already-recorded order number', () => {
  // Both conditions block the push, but only one of them is a problem the user
  // can act on, so it is the one worth surfacing.
  const d = shouldPushOrderNumber(input({
    myTrackerId: null,
    reservationBfmrOrderId: '111-4675771-1713018',
  }));
  assert.equal(d.push, false);
  assert.match(d.push === false ? d.reason : '', /myTrackerId/);
});

test('partial is by units, not by link count', () => {
  assert.equal(isPartialLink(2, 5), true);
  assert.equal(isPartialLink(5, 5), false);
  assert.equal(isPartialLink(6, 5), false, 'over-claiming is not a partial link');
  assert.equal(isPartialLink(2, null), false, 'unknown reservation size is not assumed partial');
});

test('the decision never depends on whether a link row already exists', () => {
  // The original bug in one assertion: the gate was `!existing`, so the same
  // reservation state produced different answers depending on link-row history.
  // Nothing in the input describes that history any more, so it cannot.
  const keys = Object.keys(input()).sort();
  assert.deepEqual(keys, [
    'myTrackerId',
    'orderNumber',
    'quantity',
    'reservationBfmrOrderId',
    'reservationQty',
  ]);
});
