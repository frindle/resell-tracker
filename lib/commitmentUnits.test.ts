import test from 'node:test';
import assert from 'node:assert/strict';
import { countedByLink, overLinkedCommitments, orderOverLink, type LinkUnits } from './commitmentUnits.ts';
import { finalShortPay } from './bgShortPaid.ts';

// Order 10: nine units on three commitments, three each; commitment 3 only holds two.
const links: LinkUnits[] = [
  { id: 1, orderId: 10, commitmentId: 1, quantity: 3 },
  { id: 2, orderId: 10, commitmentId: 2, quantity: 3 },
  { id: 3, orderId: 10, commitmentId: 3, quantity: 3 },
];
const counts = new Map([[1, 3], [2, 3], [3, 2]]);

test('a link counts only the units its commitment can still give', () => {
  assert.deepEqual([...countedByLink(links, counts)], [[1, 3], [2, 3], [3, 2]]);
});

test('links claim units in id order across orders', () => {
  const two = [...links, { id: 4, orderId: 11, commitmentId: 1, quantity: 2 }];
  const m = countedByLink(two, new Map([[1, 4], [2, 3], [3, 3]]));
  assert.equal(m.get(1), 3);
  assert.equal(m.get(4), 1); // only one unit left
});

test('over-linked commitments are listed, exact fits are not', () => {
  assert.deepEqual(overLinkedCommitments(links, counts), [{ commitmentId: 3, count: 2, linked: 3 }]);
  assert.deepEqual(overLinkedCommitments(links, new Map([[1, 3], [2, 3], [3, 3]])), []);
});

test('an order shows "9 units, 8 committed"; a clean order shows nothing', () => {
  assert.deepEqual(orderOverLink(10, links, counts), { linked: 9, committed: 8 });
  assert.equal(orderOverLink(10, links, new Map([[1, 3], [2, 3], [3, 3]])), null);
  assert.equal(orderOverLink(99, links, counts), null);
});

test('a short pay on an over-linked order is not reported as short', () => {
  const base = { fullyCredited: true, trulyPaid: 894.94, inBalance: 894.94, expected: 899.91 };
  assert.equal(finalShortPay(base), 4.97);
  assert.equal(finalShortPay({ ...base, overLinked: true }), null);
});
