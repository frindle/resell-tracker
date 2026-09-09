// Adversarial unit tests for the pure link-invariant guard (repo convention:
// relative import, run under `node --experimental-strip-types --test`).
import test from 'node:test';
import assert from 'node:assert/strict';
import { guardLink, normTracking } from './bfmrLinkGuard.ts';

// current links on order 907: reservation 165063 has one link (qty 2),
// reservation 216257 has one (qty 1, tracking ...592549).
const order907 = () => ([
  { id: 152, reservationId: 165063, quantity: 2, trackingNumber: '1Z999AA10123456784' },
  { id: 158, reservationId: 216257, quantity: 1, trackingNumber: '1Z999AA10100592549' },
]);

test('normTracking strips whitespace and upper-cases; nullish -> empty', () => {
  assert.equal(normTracking(' 1z999 aa10 '), '1Z999AA10');
  assert.equal(normTracking(null), '');
  assert.equal(normTracking(undefined), '');
  assert.equal(normTracking(''), '');
});

test('REJECT: creating a 2nd link with a tracking already on the order (the 907 bug)', () => {
  const r = guardLink(order907(), { orderId: 907, reservationId: 165063, quantity: 1,
    trackingNumber: '1z999aa1010 0592549', reservationQty: 3 });
  assert.equal(r.ok, false);
  assert.match((r as any).reason, /duplicate tracking/i);
});

test('REJECT: create that pushes reservation sum over reservation.qty', () => {
  const r = guardLink(order907(), { orderId: 907, reservationId: 165063, quantity: 1,
    trackingNumber: null, reservationQty: 2 });
  assert.equal(r.ok, false);
  assert.match((r as any).reason, /over-alloc/i);
});

test('ACCEPT: create within budget, unique tracking', () => {
  const r = guardLink(order907(), { orderId: 907, reservationId: 165063, quantity: 1,
    trackingNumber: '1Z999AA10199999999', reservationQty: 3 });
  assert.equal(r.ok, true);
});

test('ACCEPT: updating a link IN PLACE does not collide with itself (excludeLinkId)', () => {
  const r = guardLink(order907(), { orderId: 907, reservationId: 216257, quantity: 1,
    trackingNumber: '1Z999AA10100592549', reservationQty: 1, excludeLinkId: 158 });
  assert.equal(r.ok, true);
});

test('REJECT: assigning link 152 a tracking that duplicates link 158 (assign-path dup)', () => {
  const r = guardLink(order907(), { orderId: 907, reservationId: 165063, quantity: 2,
    trackingNumber: '1Z999AA10100592549', reservationQty: 3, excludeLinkId: 152 });
  assert.equal(r.ok, false);
  assert.match((r as any).reason, /duplicate tracking/i);
});

test('ACCEPT: null/blank tracking never counts as a duplicate of another blank', () => {
  const links = [
    { id: 1, reservationId: 500, quantity: 1, trackingNumber: null },
    { id: 2, reservationId: 501, quantity: 1, trackingNumber: '   ' },
  ];
  const r = guardLink(links, { orderId: 907, reservationId: 502, quantity: 1,
    trackingNumber: null, reservationQty: 5 });
  assert.equal(r.ok, true);
});

test('budget sums ONLY the target reservation, ignoring other reservations on the order', () => {
  const r = guardLink(order907(), { orderId: 907, reservationId: 165063, quantity: 1,
    trackingNumber: 'UNIQUE-1', reservationQty: 3 });
  assert.equal(r.ok, true);
});

test('in-place update that RAISES quantity over budget is rejected', () => {
  const r = guardLink(order907(), { orderId: 907, reservationId: 165063, quantity: 4,
    trackingNumber: '1Z999AA10123456784', reservationQty: 3, excludeLinkId: 152 });
  assert.equal(r.ok, false);
  assert.match((r as any).reason, /over-alloc/i);
});
