// Pure tests: a deposit that equals a group's own payment is matched to exactly that payment's orders. Made-up data only.
// The DB-backed parts (stored payments, auto-accept, undo) are in bank/groupPayments.db.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestDeposits, depositAutoOption, type MatchPayout, type MatchTxn, type MatchGroupPayment } from './match.ts';
import { paymentDay, cardNetPrice, commonBuyerId, dayOf, bfmrBatches, type BfmrPaidRes } from '../groupPaymentDay.ts';

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
  assert.equal(run('2027-02-28'), 'payment'); // one day early: payments stored with the received day, the bank posts on the send day
  assert.notEqual(run('2027-02-27'), 'payment');
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
  // sendOn wins (the deposit posts on it), then receivedOn, then the name
  assert.equal(paymentDay('2027-03-02', 'P1-20270301', '2027-03-01'), '2027-03-01');
  assert.equal(paymentDay('2027-03-02', 'P1-20270301', ''), '2027-03-02');
  assert.equal(paymentDay('', 'P1-20270305', null), '2027-03-05');
  assert.equal(commonBuyerId([null, 4, 4, 2]), 4);
  assert.equal(commonBuyerId([null]), null);
});

// ---- BFMR batches, derived from stored reservations ----
const res = (id: number, day: string, amountPaid: number | null, links: [number, number][], o: Partial<BfmrPaidRes> = {}): BfmrPaidRes =>
  ({ id, qty: links.reduce((a, l) => a + l[1], 0), day, amountPaid, totalPayout: null, links: links.map(([orderId, quantity]) => ({ orderId, quantity })), ...o });

test('bfmr batch: the day total is the sum of amount_paid over that day, split to orders by quantity', () => {
  const { batches, paidByOrder } = bfmrBatches([
    res(1, '2027-03-01', 100.5, [[1, 1]]), res(2, '2027-03-01', 90, [[2, 2]]), res(3, '2027-03-01', 99.99, [[3, 1], [4, 1]]),
    res(4, '2027-03-05', 10, [[5, 1]]),
  ]);
  const b = batches.find(x => x.ref === 'bfmr:2027-03-01')!;
  assert.equal(b.amountCents, 29049);
  assert.deepEqual(b.orders, [{ orderId: 1, cents: 10050 }, { orderId: 2, cents: 9000 }, { orderId: 3, cents: 4999 }, { orderId: 4, cents: 5000 }]);
  assert.equal(b.orders.reduce((a, o) => a + o.cents, 0), b.amountCents);
  assert.equal(b.usedPayoutFallback, false);
  assert.equal(paidByOrder.get(2), 9000);
  assert.equal(batches.some(x => x.ref.includes('+')), false); // days 4 apart: no two-day batch
});

test('bfmr batch: total_payout only where amount_paid is absent, and said so; an unlinked reservation makes the batch not exact', () => {
  const { batches, paidByOrder } = bfmrBatches([res(1, '2027-03-01', null, [[1, 1]], { totalPayout: 50 }), res(2, '2027-03-01', 25, [[2, 1]]), res(3, '2027-03-01', 10, [])]);
  const b = batches[0];
  assert.equal(b.usedPayoutFallback, true);
  assert.equal(b.amountCents, 8500);
  assert.equal(b.orders.reduce((a, o) => a + o.cents, 0), 7500); // the unlinked 10.00 is in the total only
  assert.equal(paidByOrder.has(1), false); // fallback is not an actual paid amount
  assert.equal(paidByOrder.get(2), 2500);
});

test('bfmr batch: a batch paid across midnight is also offered as the two days together', () => {
  const { batches } = bfmrBatches([res(1, '2027-03-01', 40, [[1, 1]]), res(2, '2027-03-02', 60, [[2, 1]])]);
  const two = batches.find(x => x.ref === 'bfmr:2027-03-01+2027-03-02')!;
  assert.deepEqual([two.day, two.amountCents, two.orders.length], ['2027-03-02', 10000, 2]);
});

test('dayOf reads ISO and US timestamps', () => {
  assert.equal(dayOf('2027-03-01 10:11:12'), '2027-03-01');
  assert.equal(dayOf('03/05/2027 10:11:12'), '2027-03-05');
  assert.equal(dayOf('soon'), null);
  assert.equal(dayOf(null), null);
});

test('bfmr payment: the batch is matched like CardCenter\'s, labeled, and a fee shows as a shortfall', () => {
  // six orders owed 20100.. in total, BFMR paid 6.00 less on the batch: exact on amount_paid
  const paid = six.map(p => ({ orderId: p.orderId, cents: p.openCents - (p.orderId === 1 ? 600 : 0) }));
  const g = gp({ id: -1, group: 'bfmr', ref: 'bfmr:2027-03-01', orders: paid });
  const [s] = suggestDeposits([dep(g.amountCents, '2027-03-02')], DEP, six, new Map(), [g]);
  assert.equal(s.options.length, 1);
  assert.deepEqual([s.options[0].how, s.options[0].payment, s.options[0].shortfallCents], ['payment', 'bfmr:2027-03-01', 600]);
  assert.ok(depositAutoOption({ kind: 'deposit', buyerId: s.buyerId, aliased: s.aliased, options: s.options }));
});

// ---- BG: a payment with no order list labels the deposit and narrows the search to orders BG has paid ----
const bgPay = gp({ id: 5, group: 'bg', ref: 'bg:PAY1', orders: [], amountCents: 121010 });
test('bg payment: only orders BG has paid are searched, so the one exact subset wins and is auto-accepted', () => {
  // an unpaid-by-BG order would give a second subset; with it excluded exactly one fits
  const ps: MatchPayout[] = [
    { ...po(1, 7, '2027-03-01', 50000), groupPaid: true }, { ...po(2, 7, '2027-03-01', 40000), groupPaid: true },
    { ...po(3, 7, '2027-03-01', 31010), groupPaid: true }, { ...po(4, 7, '2027-03-01', 31010), groupPaid: false },
    { ...po(5, 7, '2027-03-01', 95000), groupPaid: true },
  ];
  const [s] = suggestDeposits([dep(121010, '2027-03-03')], DEP, ps, new Map(), [bgPay]);
  assert.equal(s.options.length, 1);
  assert.deepEqual(s.options[0].parts.map(p => p.orderId), [1, 2, 3]);
  assert.equal(s.options[0].payment, 'bg:PAY1');
  assert.ok(depositAutoOption({ kind: 'deposit', buyerId: s.buyerId, aliased: s.aliased, options: s.options }));
  // two paid subsets fit: the user picks
  const two = [...ps.slice(0, 3), { ...po(6, 7, '2027-03-01', 31010), groupPaid: true }];
  const [t] = suggestDeposits([dep(121010, '2027-03-03')], DEP, two, new Map(), [bgPay]);
  assert.equal(t.options.length, 2);
  assert.equal(depositAutoOption({ kind: 'deposit', buyerId: t.buyerId, aliased: t.aliased, options: t.options }), null);
});

test('bg payment: no exact subset of paid orders falls back to the ordinary search; wrong amount or day is not labeled', () => {
  const ps: MatchPayout[] = [{ ...po(1, 7, '2027-03-01', 60000), groupPaid: true }, { ...po(2, 7, '2027-03-01', 61010), groupPaid: true }, po(3, 7, '2027-03-01', 60000)];
  const run = (amt: number, day: string) => suggestDeposits([dep(amt, day)], DEP, ps, new Map(), [bgPay])[0]?.options[0]?.payment;
  assert.equal(run(121010, '2027-03-03'), 'bg:PAY1');
  assert.equal(run(121010, '2027-03-12'), undefined);
  assert.equal(run(121011, '2027-03-03'), undefined);
  const ps2 = [{ ...po(1, 7, '2027-03-01', 70000), groupPaid: true }, po(2, 7, '2027-03-01', 51010)];
  const [s] = suggestDeposits([dep(121010, '2027-03-03')], DEP, ps2, new Map(), [bgPay]);
  assert.equal(s.options[0].payment, undefined); // the old guess still finds 1+2
  assert.deepEqual(s.options[0].parts.map(p => p.orderId), [1, 2]);
});

// ---- subset search counts what the group actually paid ----
test('subset search uses the paid amount when it is less than the expected payout', () => {
  // three orders expected 10000 each; BFMR paid 9610 + 9610 + 9610 = 28830 (the old search found only near misses)
  const ps = [1, 2, 3, 4].map(i => ({ ...po(i, 7, '2027-03-01', 10000), payOpenCents: i === 4 ? undefined : 9610 }));
  const [s] = suggestDeposits([dep(28830, '2027-03-03')], DEP, ps, new Map([['ACH AMA INVESTMENT', 7]]));
  assert.equal(s.options[0].how, 'subset');
  assert.deepEqual(s.options[0].parts.map(p => [p.orderId, p.cents]), [[1, 9610], [2, 9610], [3, 9610]]);
  assert.equal(s.options[0].shortfallCents, 1170); // expected less paid: shown for the user to classify
  assert.equal(depositAutoOption({ kind: 'deposit', buyerId: s.buyerId, aliased: s.aliased, options: s.options }), null);
});

test('cardNetPrice: the listing purchasePrice is the card net; a negative line never becomes the price', () => {
  assert.equal(cardNetPrice(40, 40), 40);
  assert.equal(cardNetPrice(-2, 37.5), 37.5); // fee line on a card an earlier payment paid 39.5
  assert.equal(cardNetPrice(-40.75, -2), -2); // full clawback plus fee
  assert.equal(cardNetPrice(-2, 38), 38);
  assert.equal(cardNetPrice(40, undefined), 40);
  assert.equal(cardNetPrice(40, null), 40);
  assert.equal(cardNetPrice(-2, undefined), undefined);
});

// ---- a fee line: a negative part on an order an earlier deposit already paid ----
const feePay = () => {
  const a = po(1, 7, '2027-03-01', 16000);
  const x = po(2, 7, '2027-02-01', 0); // paid earlier, its open amount is spent
  const g = gp({ paidDay: '2027-03-01', orders: [{ orderId: 1, cents: 16000 }, { orderId: 2, cents: -200 }] });
  return { a, x, g };
};

test('payment: a negative part (fee clawed back from an earlier order) is still the exact option, with no shortfall on the positive order', () => {
  const { a, x, g } = feePay();
  assert.equal(g.amountCents, 15800);
  const [s] = suggestDeposits([dep(15800, '2027-03-01')], DEP, [a, x], new Map(), [g]);
  assert.equal(s.options.length, 1);
  assert.equal(s.options[0].how, 'payment');
  assert.deepEqual(s.options[0].parts, [{ orderId: 1, cents: 16000 }, { orderId: 2, cents: -200 }]);
  assert.equal(s.options[0].parts.reduce((t, p) => t + p.cents, 0), 15800);
  assert.equal(s.options[0].shortfallCents, 0);
  assert.equal(s.fromGroup, true);
  assert.ok(depositAutoOption({ kind: 'deposit', buyerId: s.buyerId, aliased: s.aliased, options: s.options }));
});

test('payment: the negative part needs a paid order to exist; the positive orders still must be open', () => {
  const { a, x, g } = feePay();
  const how = (ps: MatchPayout[]) => suggestDeposits([dep(15800, '2027-03-01')], DEP, ps, new Map(), [g])[0]?.options[0]?.how;
  assert.notEqual(how([a]), 'payment'); // order 2 is not a paid order
  assert.notEqual(how([{ ...a, openCents: 0 }, x]), 'payment'); // order 1 already cleared
});

test('payment: a deposit one day before the stored day matches (stored before the next sync fixed the day)', () => {
  const { a, x, g } = feePay();
  const run = (day: string) => suggestDeposits([dep(15800, day)], DEP, [a, x], new Map(), [g])[0]?.options[0]?.how;
  assert.equal(run('2027-02-28'), 'payment');
  assert.notEqual(run('2027-02-27'), 'payment');
});
