import test from 'node:test';
import assert from 'node:assert/strict';
import { unitsFreeForOrder, offerableCommitments, planLinkChange, exceedsCapacity } from './bigskyOrderLinks.ts';

const c = (id: number, open: number, expired = false) => ({ id, open, expired });

test('unitsFreeForOrder subtracts only what other orders hold', () => {
  assert.equal(unitsFreeForOrder({ open: 2, othersPlanned: 0 }), 2);
  assert.equal(unitsFreeForOrder({ open: 2, othersPlanned: 2 }), 0);
  assert.equal(unitsFreeForOrder({ open: 3, othersPlanned: 1 }), 2);
});

test('unitsFreeForOrder never goes negative', () => {
  assert.equal(unitsFreeForOrder({ open: 0, othersPlanned: 0 }), 0);
  assert.equal(unitsFreeForOrder({ open: 1, othersPlanned: 5 }), 0);
});

test('a cancelled order\'s own link does not make room when others hold every unit', () => {
  // open=2, another order holds 2: nothing is free whatever this order's link says.
  const out = offerableCommitments([c(1, 2)], new Map([[1, 2]]), new Map([[1, 2]]), new Set());
  assert.deepEqual(out, []);
});

test('offerableCommitments keeps a commitment full only because of this order', () => {
  // Commitment 1 is held by others (1 of 1): not offered. Commitment 2 has no
  // other holders, so it is offered even though this order is linked to it.
  const rows = [c(1, 1), c(2, 1), c(3, 2)];
  const out = offerableCommitments(rows, new Map([[1, 1]]), new Map([[2, 1]]), new Set());
  assert.deepEqual(out.map(r => r.id), [2, 3]);
  assert.equal(out[0].linkedQuantity, 1);
  assert.equal(out[0].free, 1);
});

test('offerableCommitments drops expired and scan-filled commitments', () => {
  const rows = [c(1, 2, true), c(2, 2), c(3, 2)];
  const out = offerableCommitments(rows, new Map(), new Map(), new Set([2]));
  assert.deepEqual(out.map(r => r.id), [3]);
});

test('planLinkChange: plain link deletes nothing', () => {
  assert.deepEqual(planLinkChange([], 5, null), { ok: true, deleteLinkId: null });
});

test('planLinkChange: change removes the old link', () => {
  assert.deepEqual(planLinkChange([{ id: 10, commitmentId: 1 }], 5, 10), { ok: true, deleteLinkId: 10 });
});

test('planLinkChange: same commitment only updates quantity', () => {
  assert.deepEqual(planLinkChange([{ id: 10, commitmentId: 5 }], 5, 10), { ok: true, deleteLinkId: null });
});

test('planLinkChange: unknown link is refused', () => {
  const r = planLinkChange([{ id: 10, commitmentId: 1 }], 5, 99);
  assert.equal(r.ok, false);
});

test('exceedsCapacity: a new link needs room', () => {
  assert.equal(exceedsCapacity(2, 2, null), false);
  assert.equal(exceedsCapacity(3, 2, null), true);
  assert.equal(exceedsCapacity(1, 0, null), true);
});

test('exceedsCapacity: lowering or keeping an own link passes on an over-committed commitment', () => {
  assert.equal(exceedsCapacity(2, 0, 3), false);
  assert.equal(exceedsCapacity(3, 0, 3), false);
});

test('exceedsCapacity: raising an own link still needs room', () => {
  assert.equal(exceedsCapacity(4, 3, 3), true);
  assert.equal(exceedsCapacity(4, 4, 3), false);
});

test('planLinkChange: target already linked on another link is refused', () => {
  const r = planLinkChange([{ id: 10, commitmentId: 1 }, { id: 11, commitmentId: 5 }], 5, 10);
  assert.equal(r.ok, false);
});
