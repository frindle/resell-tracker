// Pure tests: a deposit that equals a group's own payment is matched to exactly that payment's orders. Made-up data only.
// The DB-backed parts (stored payments, auto-accept, undo) are in bank/groupPayments.db.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestDeposits, depositAutoOption, type MatchPayout, type MatchTxn, type MatchGroupPayment } from './match.ts';
import { paymentDay, commonBuyerId } from '../groupPaymentDay.ts';

const DEP = new Set([2]);
let nid = 900;
const dep = (amountCents: number, postedDate: string, description = 'ACH: AMA Investment 7781'): MatchTxn =>
  ({ id: nid++, accountId: 2, postedDate, amountCents, description, matchStatus: 'unmatched' });
const po = (orderId: number, buyerId: number | null, paidDay: string, openCents: number): MatchPayout => ({ orderId, buyerId, paidDay, paidCents: openCents, openCents });
const gp = (o: Partial<MatchGroupPayment> & { orders: { orderId: number; cents: number }[] }): MatchGroupPayment => {
  const total = o.orders.reduce((a, p) => a + p.cents, 0);
  return { id: 1, buyerId: 7, buyerName: 'AMA Investment', paidDay: '2027-03-01', amountCents: total, ...o };
};
// six orders; every 3-order subset could be a guess, only the payment says which
const six = [1, 2, 3, 4, 5, 6].map(i => po(i, 7, '2027-03-01', 20000 + i * 100));
const payment = gp({ orders: six.map(p => ({ orderId: p.orderId, cents: p.openCents })) });
const total = payment.amountCents;

test('payment: a deposit of exactly the payment total is matched to exactly its orders, one option', () => {
  const [s] = suggestDeposits([dep(total, '2027-03-03')], DEP, [...six, po(9, 7, '2027-02-27', total - 1)], new Map(), [payment]);
  assert.equal(s.options.length, 1);
  assert.equal(s.options[0].how, 'payment');
  assert.deepEqual(s.options[0].parts.map(p => p.orderId), [1, 2, 3, 4, 5, 6]);
  assert.equal(s.options[0].shortfallCents, 0);
  assert.equal(s.aliased, true);
  assert.ok(depositAutoOption({ kind: 'deposit', buyerId: s.buyerId, aliased: s.aliased, options: s.options }));
});

test('payment: the window is 0-7 days after the payment day', () => {
  const run = (day: string) => suggestDeposits([dep(total, day)], DEP, six, new Map(), [payment])[0]?.options[0]?.how;
  assert.equal(run('2027-03-01'), 'payment');
  assert.equal(run('2027-03-08'), 'payment');
  assert.notEqual(run('2027-03-09'), 'payment');
  assert.notEqual(run('2027-02-28'), 'payment');
});

test('payment: needs the exact cent, the buyer, and every order open', () => {
  const kinds = (t: MatchTxn, ps: MatchPayout[], al: [string, number][] = [], g = [payment]) => suggestDeposits([t], DEP, ps, new Map(al), g)[0]?.options[0]?.how;
  assert.notEqual(kinds(dep(total - 1, '2027-03-03'), six), 'payment'); // off by a cent
  assert.notEqual(kinds(dep(total, '2027-03-03', 'ACH: Other Payer'), six), 'payment'); // not that buyer
  assert.notEqual(kinds(dep(total, '2027-03-03', 'ACH: Other Payer'), six, [['ACH OTHER PAYER', 8]]), 'payment'); // aliased to another buyer
  assert.equal(kinds(dep(total, '2027-03-03', 'ACH: Other Payer'), six, [['ACH OTHER PAYER', 7]]), 'payment'); // alias of that buyer
  assert.notEqual(kinds(dep(total, '2027-03-03'), six.map(p => p.orderId === 3 ? { ...p, openCents: 0 } : p)), 'payment'); // one order already cleared
  assert.notEqual(kinds(dep(total, '2027-03-03'), six.slice(0, 5)), 'payment'); // an order is not waiting
  // its orders do not add up to the total: not exact
  assert.notEqual(kinds(dep(total, '2027-03-03'), six, [], [{ ...payment, orders: payment.orders.slice(0, 5) }]), 'payment');
});

test('payment: a fee (orders owed more than the payment) keeps the batch total and records the shortfall', () => {
  const owed = six.map(p => ({ ...p, openCents: p.openCents + (p.orderId === 1 ? 500 : 0) }));
  const [s] = suggestDeposits([dep(total, '2027-03-03')], DEP, owed, new Map(), [payment]);
  assert.equal(s.options[0].how, 'payment');
  assert.equal(s.options[0].shortfallCents, 500);
  assert.equal(s.options[0].parts.reduce((a, p) => a + p.cents, 0), total);
  assert.ok(depositAutoOption({ kind: 'deposit', buyerId: s.buyerId, aliased: true, options: s.options }));
});

test('payment: two payments of the same total are both offered (the user picks, never auto); no payment falls back to the subset guess', () => {
  const other = gp({ id: 2, paidDay: '2027-03-02', orders: [{ orderId: 11, cents: 5000 }, { orderId: 12, cents: 6000 }] });
  const a = gp({ id: 3, paidDay: '2027-03-01', orders: [{ orderId: 13, cents: 6000 }, { orderId: 14, cents: 5000 }] });
  const ps = [po(11, 7, '2027-03-02', 5000), po(12, 7, '2027-03-02', 6000), po(13, 7, '2027-03-01', 6000), po(14, 7, '2027-03-01', 5000)];
  const [s] = suggestDeposits([dep(11000, '2027-03-03')], DEP, ps, new Map(), [other, a]);
  assert.deepEqual(s.options.map(o => o.parts.map(p => p.orderId)), [[13, 14], [11, 12]]);
  assert.equal(depositAutoOption({ kind: 'deposit', buyerId: 7, aliased: true, options: s.options }), null);
  const [f] = suggestDeposits([dep(11000, '2027-03-03')], DEP, ps, new Map(), []); // no stored payment: old behaviour
  assert.notEqual(f.options[0].how, 'payment');
});

test('payment day and buyer helpers', () => {
  assert.equal(paymentDay('2027-03-01', 'P1-20270101'), '2027-03-01');
  assert.equal(paymentDay('', 'P1056-20270309'), '2027-03-09');
  assert.equal(paymentDay(undefined, 'weird'), null);
  assert.equal(commonBuyerId([null, 4, 4, 2]), 4);
  assert.equal(commonBuyerId([null]), null);
});
