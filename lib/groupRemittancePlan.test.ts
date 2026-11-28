// What a payment email can be tied to. Invented orders and tracking numbers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { planRemittance, trackingIndex, pickOwner, fallbackRef } from './groupRemittancePlan.ts';
import { dedupBfmrPayments, type BfmrDedupPayment } from './groupPaymentDay.ts';

const orders = [
  { id: 1, trackingNumbers: '1ZTEST000000000001, 1ZTEST000000000011', buyerId: 7 },
  { id: 2, trackingNumbers: 'tba000000000002', buyerId: 7 },
  { id: 3, trackingNumbers: '1ZTEST000000000099', buyerId: 7 },
  { id: 4, trackingNumbers: '1ztest000000000099', buyerId: 7 }, // same number on two orders: ambiguous
];
const idx = trackingIndex(orders);

test('plan: every line resolves (case-insensitive, either of an order\'s numbers) and adds up: exact', () => {
  const p = planRemittance(30000, [{ tracking: '1ztest000000000001', amountCents: 10000 }, { tracking: '1ZTEST000000000011', amountCents: 5000 }, { tracking: 'TBA000000000002', amountCents: 15000 }], idx);
  assert.equal(p.exact, true);
  assert.deepEqual([...p.amounts], [[1, 15000], [2, 15000]]);
  assert.equal(p.unresolved, 0);
});

test('plan: an unknown or ambiguous tracking number is unresolved and the payment is not exact', () => {
  const p = planRemittance(30000, [{ tracking: '1ZTEST000000000001', amountCents: 10000 }, { tracking: 'NOPE000000000000', amountCents: 10000 }, { tracking: '1ZTEST000000000099', amountCents: 10000 }], idx);
  assert.equal(p.exact, false);
  assert.equal(p.unresolved, 2);
  assert.equal(p.resolved, 1);
});

test('plan: lines that do not add up to the total, or no lines, are not exact', () => {
  assert.equal(planRemittance(30001, [{ tracking: '1ZTEST000000000001', amountCents: 30000 }], idx).exact, false);
  assert.equal(planRemittance(100, [], idx).exact, false);
});

test('owner: the user most lines resolve for; a tie or nothing is nobody', () => {
  assert.equal(pickOwner(new Map([[1, 3], [2, 1]])), 1);
  assert.equal(pickOwner(new Map([[1, 2], [2, 2]])), null);
  assert.equal(pickOwner(new Map([[1, 0]])), null);
});

test('fallbackRef is stable for the same email and differs by trackings', () => {
  const a = [{ tracking: 'AAA', amountCents: 1 }, { tracking: 'BBB', amountCents: 2 }];
  assert.equal(fallbackRef('2027-02-10', 3, a), fallbackRef('2027-02-10', 3, [...a].reverse()));
  assert.notEqual(fallbackRef('2027-02-10', 3, a), fallbackRef('2027-02-10', 3, [{ tracking: 'CCC', amountCents: 3 }]));
});

const pay = (o: Partial<BfmrDedupPayment> & { id: number }): BfmrDedupPayment => ({ group: 'bfmr', ref: `bfmr:x${o.id}`, paidDay: '2027-02-09', amountCents: 300, orders: [], ...o });

test('dedup: the email row wins over the reservation-derived day (stored and derived), per shared order', () => {
  const email = pay({ id: 1, ref: 'bfmr:PAY-1', orders: [{ orderId: 1, cents: 100 }, { orderId: 2, cents: 200 }] });
  const storedDay = pay({ id: 2, ref: 'bfmr:bfmr-2027-02-09', orders: [{ orderId: 1, cents: 100 }, { orderId: 2, cents: 200 }] });
  const derived = pay({ id: -1, ref: 'bfmr:2027-02-09', orders: [{ orderId: 2, cents: 200 }, { orderId: 3, cents: 100 }] });
  const other = pay({ id: -2, ref: 'bfmr:2027-02-20', orders: [{ orderId: 9, cents: 300 }] });
  assert.deepEqual(dedupBfmrPayments([email, storedDay, derived, other]).map(p => p.id), [1, -2]);
});

test('dedup: a total-only email row yields to an exact row of the same amount within a day; other groups are untouched', () => {
  const totalOnly = pay({ id: 1, ref: 'bfmr:PAY-2' });
  const derived = pay({ id: -1, ref: 'bfmr:2027-02-10', paidDay: '2027-02-10', orders: [{ orderId: 1, cents: 300 }] });
  assert.deepEqual(dedupBfmrPayments([totalOnly, derived]).map(p => p.id), [-1]);
  const far = pay({ id: 3, ref: 'bfmr:PAY-3', paidDay: '2027-02-20' });
  assert.deepEqual(dedupBfmrPayments([far, derived]).map(p => p.id), [3, -1]);
  const cc = pay({ id: 4, group: 'cc', ref: 'cc:P1', orders: [{ orderId: 1, cents: 300 }] });
  assert.deepEqual(dedupBfmrPayments([cc, derived]).map(p => p.id), [4, -1]);
});
