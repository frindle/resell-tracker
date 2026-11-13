// Pure tests for P3: split / part-paid / refund / pair matching, bank-row postings, tax fill, reconcile and its gate inputs.
// Made-up data only. The DB-backed parts (migration copy, link sums, lock gate) are in bank/bank.db.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  suggestSplits, suggestCharges, suggestRefunds, suggestPairs, suggestAll, inChargeWindow, orderCovered, remainingChargeCents,
  type MatchTxn, type MatchOrder, type MatchAccount, type MatchReturn, type CardLastFours,
} from './match.ts';
import { desiredBankEntries, type BankAcctForBooks } from './bankPostings.ts';
import { reconcileMonth, statementAtMonthEnd, recOk } from './bankReconcile.ts';
import { MemoryStore } from './memoryStore.ts';
import { applyDesired, reconcileOrders } from './reconcile.ts';
import { type OrderForBooks, taxFillCents, chargeDifference } from './orderPostings.ts';
import { assertBalanced } from './ledger.ts';

const U = 1;
const GO = '2027-01-01';
const NOW = new Date('2027-03-20T20:00:00Z');

const acct: MatchAccount[] = [{ id: 1, last4: null, creditCardId: 7 }, { id: 2, last4: null, creditCardId: 8 }, { id: 3, last4: null, creditCardId: null }];
const fours: CardLastFours = new Map();
let nid = 100;
const tx = (o: Partial<MatchTxn> & { amountCents: number; postedDate: string }): MatchTxn =>
  ({ id: nid++, accountId: 1, description: 'ACME STORE', matchStatus: 'unmatched', ...o });
const ord = (o: Partial<MatchOrder> & { id: number }): MatchOrder => ({
  platform: 'Acme', orderNumber: null, orderDate: '2027-02-01', cardId: 7, cost: 100, shippingCost: 0, insuranceCost: 0,
  taxAmount: 0, subtotalAmount: 100, cancelled: false, ...o,
});

// ---- splits ----
test('split: two and three charges adding up to one order are suggested', () => {
  const o = ord({ id: 1 });
  const two = [tx({ id: 1, amountCents: -4000, postedDate: '2027-02-02' }), tx({ id: 2, amountCents: -6000, postedDate: '2027-02-08' })];
  assert.deepEqual(suggestSplits(two, acct, [o], fours), [{ orderId: 1, subsets: [[1, 2]] }]);
  const three = [tx({ id: 1, amountCents: -2500, postedDate: '2027-02-02' }), tx({ id: 2, amountCents: -2500, postedDate: '2027-02-05' }), tx({ id: 3, amountCents: -5000, postedDate: '2027-02-08' })];
  assert.deepEqual(suggestSplits(three, acct, [o], fours), [{ orderId: 1, subsets: [[1, 2, 3]] }]);
});

test('split: near misses (sum off, over 7 days, other card) suggest nothing', () => {
  const o = ord({ id: 1 });
  assert.deepEqual(suggestSplits([tx({ id: 1, amountCents: -4000, postedDate: '2027-02-02' }), tx({ id: 2, amountCents: -5900, postedDate: '2027-02-09' })], acct, [o], fours), []);
  assert.deepEqual(suggestSplits([tx({ id: 1, amountCents: -4000, postedDate: '2027-02-02' }), tx({ id: 2, amountCents: -6000, postedDate: '2027-02-09' })], acct, [o], fours), []);
  assert.deepEqual(suggestSplits([tx({ id: 1, amountCents: -4000, postedDate: '2027-02-02' }), tx({ id: 2, accountId: 2, amountCents: -6000, postedDate: '2027-02-09' })], acct, [o], fours), []);
});

test('split: nine candidate charges are not searched, eight are', () => {
  const o = ord({ id: 1, subtotalAmount: 90, cost: 90 });
  const mk = (n: number) => Array.from({ length: n }, (_, i) => tx({ id: i + 1, amountCents: -(9000 / n), postedDate: '2027-02-03' }));
  assert.equal(suggestSplits(mk(9), acct, [o], fours).length, 0);
  const o8 = ord({ id: 1, subtotalAmount: 80, cost: 80 });
  assert.equal(suggestSplits(mk(8).map(t => ({ ...t, amountCents: -1000 })), acct, [o8], fours).length, 1);
});

test('split: two subsets that both fit are both reported (the user picks)', () => {
  const o = ord({ id: 1 });
  const t = [
    tx({ id: 1, amountCents: -4000, postedDate: '2027-02-02' }), tx({ id: 2, amountCents: -6000, postedDate: '2027-02-03' }),
    tx({ id: 3, amountCents: -3000, postedDate: '2027-02-04' }), tx({ id: 4, amountCents: -7000, postedDate: '2027-02-05' }),
  ];
  const r = suggestSplits(t, acct, [o], fours);
  assert.deepEqual(r[0].subsets, [[1, 2], [3, 4]]);
  const all = suggestAll(t, acct, [o], fours);
  assert.equal(all.get(1)?.kind, 'split');
  assert.equal((all.get(1) as { subsets: number[][] }).subsets.length, 2);
});

// ---- charge window ----
test('charge window: 0-7 days after the order date, whatever the description says', () => {
  const o = ord({ id: 1, orderDate: '2027-02-01', orderNumber: '112-3456789-0001' });
  assert.equal(inChargeWindow(o, { postedDate: '2027-02-01' }), true); // same day
  assert.equal(inChargeWindow(o, { postedDate: '2027-02-08' }), true); // day 7
  assert.equal(inChargeWindow(o, { postedDate: '2027-02-09' }), false); // day 8
  assert.equal(inChargeWindow(o, { postedDate: '2027-01-31' }), false); // before the order
  const late = tx({ id: 1, amountCents: -10000, postedDate: '2027-03-09', description: 'ACME 112-3456789-0001' });
  assert.deepEqual(suggestCharges([late], acct, [o], fours), []); // an order number does not widen it
});

// ---- orders paid in parts ----
test('part-paid order: only what is left is offered, and a paid-up order is offered nothing', () => {
  const o = ord({ id: 1, cost: 100, subtotalAmount: 100, taxAmount: 0 });
  assert.deepEqual(remainingChargeCents({ ...o, linkedCents: 4000 }), { min: 6000, max: 6000, exact: true });
  assert.equal(orderCovered({ ...o, linkedCents: 9999 }), false);
  assert.equal(orderCovered({ ...o, linkedCents: 10000 }), true);
  const rest = tx({ id: 1, amountCents: -6000, postedDate: '2027-02-05' });
  assert.deepEqual(suggestCharges([rest], acct, [{ ...o, linkedCents: 4000 }], fours), [{ txnId: 1, candidates: [{ orderId: 1, exact: true }] }]);
  assert.deepEqual(suggestCharges([{ ...rest, amountCents: -10000 }], acct, [{ ...o, linkedCents: 4000 }], fours), []); // the full amount no longer fits
  assert.deepEqual(suggestCharges([rest], acct, [{ ...o, linkedCents: 10000 }], fours), []);
  const two = [tx({ id: 2, amountCents: -2500, postedDate: '2027-02-03' }), tx({ id: 3, amountCents: -3500, postedDate: '2027-02-06' })];
  assert.deepEqual(suggestSplits(two, acct, [{ ...o, linkedCents: 4000 }], fours), [{ orderId: 1, subsets: [[2, 3]] }]);
  assert.deepEqual(suggestSplits(two, acct, [{ ...o, linkedCents: 10000 }], fours), []);
});

test('one charge is never split across several orders', () => {
  const a = ord({ id: 1, platform: 'Costco', cost: 50, subtotalAmount: 50, taxAmount: 0 });
  const b = ord({ id: 2, platform: 'Costco', cost: 70, subtotalAmount: 70, taxAmount: 0 });
  const s = suggestAll([tx({ id: 1, amountCents: -12000, postedDate: '2027-02-03' })], acct, [a, b], fours);
  assert.equal(s.size, 0);
});

// ---- refunds and pairs ----
const ret = (o: Partial<MatchReturn> & { id: number }): MatchReturn => ({ orderId: 1, cardId: 7, refundCents: 4500, refundedDate: '2027-02-10', ...o });

test('refund: a credit for the refunded amount within 10 days is suggested; 11 days or more than the refund is not', () => {
  const hit = tx({ id: 1, amountCents: 4500, postedDate: '2027-02-20' });
  assert.deepEqual(suggestRefunds([hit], acct, [ret({ id: 5 })], fours), [{ txnId: 1, candidates: [{ returnId: 5, orderId: 1, partial: false }] }]);
  assert.deepEqual(suggestRefunds([{ ...hit, postedDate: '2027-02-21' }], acct, [ret({ id: 5 })], fours), []);
  assert.deepEqual(suggestRefunds([{ ...hit, amountCents: 4600 }], acct, [ret({ id: 5 })], fours), []);
  assert.deepEqual(suggestRefunds([{ ...hit, postedDate: '2027-02-09' }], acct, [ret({ id: 5 })], fours), []);
  assert.deepEqual(suggestRefunds([hit], acct, [ret({ id: 5 })], fours, new Set([5])), []);
  assert.deepEqual(suggestRefunds([{ ...hit, accountId: 2 }], acct, [ret({ id: 5 })], fours), []);
});

test('refund: a part refund is offered as partial, what is left shrinks, and an exact fit wins', () => {
  const part = tx({ id: 1, amountCents: 2000, postedDate: '2027-02-12' });
  assert.deepEqual(suggestRefunds([part], acct, [ret({ id: 5 })], fours), [{ txnId: 1, candidates: [{ returnId: 5, orderId: 1, partial: true }] }]);
  // 2000 already linked: 2500 is left, so a 2500 credit is the rest (not partial) and 2600 is too much.
  const rest = tx({ id: 2, amountCents: 2500, postedDate: '2027-02-15' });
  assert.deepEqual(suggestRefunds([rest], acct, [ret({ id: 5, linkedCents: 2000 })], fours), [{ txnId: 2, candidates: [{ returnId: 5, orderId: 1, partial: false }] }]);
  assert.deepEqual(suggestRefunds([{ ...rest, amountCents: 2600 }], acct, [ret({ id: 5, linkedCents: 2000 })], fours), []);
  assert.deepEqual(suggestRefunds([rest], acct, [ret({ id: 5, linkedCents: 4500 })], fours), []);
  // Two returns: one is an exact fit, the other only partly; only the exact one is offered.
  const r = suggestRefunds([rest], acct, [ret({ id: 5 }), ret({ id: 6, orderId: 2, refundCents: 2500 })], fours);
  assert.deepEqual(r, [{ txnId: 2, candidates: [{ returnId: 6, orderId: 2, partial: false }] }]);
});

test('pair: same-card charge and refund within 30 days pair; different cards or 31 days do not', () => {
  const c = tx({ id: 1, amountCents: -2599, postedDate: '2027-02-01', description: 'STREAMCO MONTHLY' });
  const r = tx({ id: 2, amountCents: 2599, postedDate: '2027-02-20', description: 'STREAMCO REFUND' });
  assert.deepEqual(suggestPairs([c, r], acct), [{ chargeId: 1, refundId: 2, days: 19 }]);
  assert.deepEqual(suggestPairs([c, { ...r, accountId: 2 }], acct), []);
  assert.deepEqual(suggestPairs([c, { ...r, postedDate: '2027-03-04' }], acct), []);
  assert.deepEqual(suggestPairs([c, { ...r, description: 'OTHERSHOP CREDIT' }], acct), []);
  assert.deepEqual(suggestPairs([c, { ...r, amountCents: 2500 }], acct), []);
});

test('suggestAll keeps the old five-argument behaviour', () => {
  const o = ord({ id: 1 });
  const t = tx({ id: 1, amountCents: -10000, postedDate: '2027-02-02' });
  const s = suggestAll([t], acct, [o], fours, new Set());
  assert.deepEqual(s.get(1), { kind: 'order', orderIds: [1] });
});

// ---- bank postings ----
const accts: BankAcctForBooks[] = [
  { id: 1, creditCardId: 7, ledgerAccountId: null }, // card
  { id: 2, creditCardId: null, ledgerAccountId: 50 }, // checking (ledger account id)
  { id: 3, creditCardId: null, ledgerAccountId: null }, // unmapped personal
];
const row = (id: number, accountId: number, postedDate: string, amountCents: number, pending = false) => ({ id, accountId, postedDate, amountCents, pending, description: `row ${id}` });
const sumLines = (d: { lines: { amountCents: number }[] }) => d.lines.reduce((s, l) => s + l.amountCents, 0);

test('card payment (transfer) posts one balanced entry dated the earlier row; the pair posts once', () => {
  const rows = [row(10, 2, '2027-02-04', -30000), row(11, 1, '2027-02-05', 30000)];
  const links = [{ txnId: 10, kind: 'transfer', refId: 11, amountCents: 30000 }, { txnId: 11, kind: 'transfer', refId: 10, amountCents: 30000 }];
  const d = desiredBankEntries({ rows, links, accounts: accts, orderDays: new Map(), goLive: GO });
  assert.equal(d.length, 1);
  assert.equal(d[0].sourceKey, 'bank:10');
  assert.equal(d[0].date, '2027-02-04');
  assert.equal(sumLines(d[0]), 0);
  const byAcct = new Map(d[0].lines.map(l => [l.account, l.amountCents]));
  assert.equal(byAcct.get('card:7'), 30000); // card liability goes down (debit)
  assert.equal(byAcct.get(50), -30000); // checking down (credit)
});

test('personal spending: a debit on a mapped account is a draw, a credit a contribution; unmapped posts nothing', () => {
  const rows = [row(1, 2, '2027-02-04', -1234), row(2, 2, '2027-02-05', 500), row(3, 3, '2027-02-06', -999)];
  const links = [1, 2, 3].map(id => ({ txnId: id, kind: 'personal', refId: 0, amountCents: Math.abs(rows[id - 1].amountCents) }));
  const d = desiredBankEntries({ rows, links, accounts: accts, orderDays: new Map(), goLive: GO });
  assert.equal(d.length, 2);
  assert.ok(d.every(e => sumLines(e) === 0));
  assert.deepEqual(d[0].lines.map(l => [l.account, l.amountCents]), [['owner_draws', 1234], [50, -1234]]);
  assert.deepEqual(d[1].lines.map(l => [l.account, l.amountCents]), [[50, 500], ['owner_contributions', -500]]);
});

test('order charge posts nothing after go-live (the order posts the purchase); pending and pre-go-live rows post nothing', () => {
  const rows = [row(1, 1, '2027-02-04', -5000), row(2, 2, '2026-12-30', -100, false), row(3, 2, '2027-02-04', -100, true)];
  const links = [
    { txnId: 1, kind: 'order_charge', refId: 9, amountCents: 5000 },
    { txnId: 2, kind: 'personal', refId: 0, amountCents: 100 },
    { txnId: 3, kind: 'personal', refId: 0, amountCents: 100 },
  ];
  const d = desiredBankEntries({ rows, links, accounts: accts, orderDays: new Map([[9, '2027-02-03']]), goLive: GO });
  assert.deepEqual(d, []);
});

test('pre-go-live order charged after go-live: Dr 3000 opening balance equity, Cr the card', () => {
  const rows = [row(1, 1, '2027-01-04', -8000)];
  const links = [{ txnId: 1, kind: 'order_charge', refId: 9, amountCents: 8000 }];
  const d = desiredBankEntries({ rows, links, accounts: accts, orderDays: new Map([[9, '2026-12-28']]), goLive: GO });
  assert.equal(d.length, 1);
  assert.equal(d[0].sourceKey, 'bank:1:opening');
  assert.deepEqual(d[0].lines.map(l => [l.account, l.amountCents]), [['opening_balance_equity', 8000], ['card:7', -8000]]);
});

function storeWithChecking(): MemoryStore {
  const s = new MemoryStore();
  // make account id 50 exist
  for (let i = 0; i < 49; i++) s.addAccount(U, { code: `9${i}`, name: `filler ${i}`, type: 'asset', active: false });
  s.addAccount(U, { code: '1010', name: 'Checking', type: 'asset' });
  return s;
}
const liveE = (s: MemoryStore) => s.entries.filter(e => e.source !== 'reversal' && !e.reversedAt);

test('posting: second run posts nothing; undoing the link reverses; a locked month redates', async () => {
  const s = storeWithChecking();
  const rows = [row(1, 2, '2027-02-04', -1234)];
  const links = [{ txnId: 1, kind: 'personal', refId: 0, amountCents: 1234 }];
  const d = desiredBankEntries({ rows, links, accounts: accts, orderDays: new Map(), goLive: GO });
  const r1 = await applyDesired(s, U, d, { prefix: 'bank:' }, NOW);
  assert.equal(r1.posted, 1);
  const r2 = await applyDesired(s, U, d, { prefix: 'bank:' }, NOW);
  assert.deepEqual([r2.posted, r2.reversed], [0, 0]);
  assert.equal(s.balance(U, 'owner_draws'), 1234);
  const undo = await applyDesired(s, U, [], { prefix: 'bank:' }, NOW);
  assert.equal(undo.reversed, 1);
  assert.equal(liveE(s).length, 0);
  assert.equal(s.balance(U, 'owner_draws'), 0);

  const s2 = storeWithChecking();
  s2.lock(U, '2027-02');
  await applyDesired(s2, U, d, { prefix: 'bank:' }, NOW);
  assert.equal(liveE(s2)[0].date, '2027-03-01');
  assert.match(liveE(s2)[0].memo, /dated 2027-02-04/);
  const again = await applyDesired(s2, U, d, { prefix: 'bank:' }, NOW);
  assert.deepEqual([again.posted, again.reversed], [0, 0]);
});

test('posting: bank entries never touch order: entries; the order scope is unchanged', async () => {
  const s = storeWithChecking();
  const rows = [row(1, 2, '2027-02-04', -1234)];
  await applyDesired(s, U, desiredBankEntries({ rows, links: [{ txnId: 1, kind: 'personal', refId: 0, amountCents: 1234 }], accounts: accts, orderDays: new Map(), goLive: GO }), { prefix: 'bank:' }, NOW);
  const o = await reconcileOrders(s, U, [], { goLive: GO, now: NOW });
  assert.equal(o.reversed, 0);
  assert.equal(liveE(s).length, 1);
});

// ---- tax fill ----
const mkOrder = (o: Partial<OrderForBooks> & { id: number }): OrderForBooks => ({
  platform: 'Acme', orderDate: new Date('2027-02-10T00:00:00Z'), cost: 100, shippingCost: 0, insuranceCost: 0, returnedCost: 0,
  salePrice: null, buyerId: null, cardId: 7, cashbackAmount: 0, portalCashback: null, amexOfferDollars: null,
  bgPaidAmount: null, bfmrStatus: null, lost: false, cancelled: false, ignoredByRule: false, giftCards: [], returns: [], ...o,
});

test('tax fill: the linked charge replaces cost when tax is unknown, and the sale cost of goods follows', async () => {
  assert.equal(taxFillCents(mkOrder({ id: 1, chargeCents: 10800 })), 10800);
  assert.equal(taxFillCents(mkOrder({ id: 1, chargeCents: 12000 })), null); // outside the tax window
  assert.equal(taxFillCents(mkOrder({ id: 1, chargeCents: 9000 })), null);
  assert.equal(taxFillCents(mkOrder({ id: 1, taxAmount: 8, subtotalAmount: 100, chargeCents: 10800 })), null); // tax known: no fill
  assert.equal(chargeDifference(mkOrder({ id: 1, taxAmount: 8, subtotalAmount: 100, chargeCents: 10900 })), 100);
  assert.equal(chargeDifference(mkOrder({ id: 1, taxAmount: 8, subtotalAmount: 100, chargeCents: 10800 })), null);

  const withFill = new MemoryStore();
  const o = mkOrder({ id: 1, salePrice: 150, buyerId: null });
  await reconcileOrders(withFill, U, [{ ...o, chargeCents: 10800 }], { goLive: GO, now: NOW });
  assert.equal(withFill.balance(U, 'card:7'), -10800);
  const plain = new MemoryStore();
  await reconcileOrders(plain, U, [o], { goLive: GO, now: NOW });
  assert.equal(plain.balance(U, 'card:7'), -10000);
  // the cost of goods sold follows the filled purchase
  const cogs = (s: MemoryStore) => s.entries.flatMap(e => e.lines.map(l => ({ l, e }))).filter(x => x.l.accountId === s.accounts.find(a => a.systemKey === 'cogs_goods')?.id).reduce((t, x) => t + x.l.amountCents, 0);
  assert.equal(cogs(withFill) - cogs(plain), 800);
  // a second run posts nothing new
  const again = await reconcileOrders(withFill, U, [{ ...o, chargeCents: 10800 }], { goLive: GO, now: NOW });
  assert.deepEqual([again.posted, again.reversed], [0, 0]);
});

// ---- reconcile ----
test('statement at month end is rolled back by rows posted after it; manual beats ofx beats simplefin on one date', () => {
  const rows = [{ id: 1, postedDate: '2027-03-03', amountCents: -500, pending: false, matchStatus: 'matched', description: 'x' }, { id: 2, postedDate: '2027-03-04', amountCents: -700, pending: true, matchStatus: 'matched', description: 'y' }];
  const st = statementAtMonthEnd([{ date: '2027-03-05', balanceCents: -20000, source: 'simplefin' }, { date: '2027-03-05', balanceCents: -20001, source: 'manual' }], rows, '2027-02-28');
  assert.equal(st?.source, 'manual');
  assert.equal(st?.cents, -20001 + 500); // the pending row is not in the bank's balance yet
  assert.equal(statementAtMonthEnd([{ date: '2027-02-10', balanceCents: 1, source: 'ofx' }], rows, '2027-02-28'), null);
});

test('reconcile fixture: daily balances, two in-transit purchases and one open row tie', () => {
  // Card (statement negative when owed). Books at Feb 28 = -(statement owed) minus purchases the bank has not charged yet.
  const rows = [
    { id: 1, postedDate: '2027-02-10', amountCents: -10000, pending: false, matchStatus: 'matched', description: 'a' },
    { id: 2, postedDate: '2027-02-27', amountCents: -2500, pending: false, matchStatus: 'unmatched', description: 'open charge' },
    { id: 3, postedDate: '2027-03-02', amountCents: -4000, pending: false, matchStatus: 'matched', description: 'late' },
  ];
  // Daily balances from the bank: Feb 28 balance -12500; Mar 2 -16500 (row 3 posted). Month-end statement = -16500 + 4000.
  const statements = [{ date: '2027-03-02', balanceCents: -16500, source: 'simplefin' }];
  // Books: order a (10000, charged row 1), order b bought Feb 27 for 3000 (charge row 3 is 4000 on Mar 2, in transit),
  // order c bought Feb 26 for 1500 with no charge yet (in transit). The open row 2 is on the statement but not in the books.
  const purchases = [
    { orderId: 1, day: '2027-02-09', purchaseCents: 10000, charges: [{ postedDate: '2027-02-10', cents: 10000 }] },
    { orderId: 2, day: '2027-02-27', purchaseCents: 4000, charges: [{ postedDate: '2027-03-02', cents: 4000 }] },
    { orderId: 3, day: '2027-02-26', purchaseCents: 1500, charges: [] },
  ];
  const books = -(10000 + 4000 + 1500);
  const r = reconcileMonth({ accountId: 1, month: '2027-02', monthEnd: '2027-02-28', goLive: GO, statements, rows, booksCents: books, purchases, transfers: [] });
  assert.equal(r.statementCents, -12500);
  assert.equal(r.diffCents, books - -12500); // -3000
  const kinds = r.items.map(i => i.kind).sort();
  assert.deepEqual(kinds, ['open_row', 'order_in_transit', 'order_in_transit']);
  assert.equal(r.unexplainedCents, 0);
  assert.equal(r.status, 'explained');
  assert.ok(recOk(r.status));
  // Without the explanations the same month does not tie.
  const bare = reconcileMonth({ accountId: 1, month: '2027-02', monthEnd: '2027-02-28', goLive: GO, statements, rows: rows.map(x => ({ ...x, matchStatus: 'matched' })), booksCents: books, purchases: [], transfers: [] });
  assert.equal(bare.status, 'unexplained');
  assert.equal(recOk(bare.status), false);
});

test('reconcile: no statement balance blocks, an account with nothing is empty, a transfer straddling month end is explained', () => {
  const none = reconcileMonth({ accountId: 2, month: '2027-02', monthEnd: '2027-02-28', goLive: GO, statements: [], rows: [{ id: 1, postedDate: '2027-02-04', amountCents: -100, pending: false, matchStatus: 'matched', description: 'x' }], booksCents: -100 });
  assert.equal(none.status, 'no_balance');
  assert.equal(recOk(none.status), false);
  assert.equal(reconcileMonth({ accountId: 2, month: '2027-02', monthEnd: '2027-02-28', goLive: GO, statements: [], rows: [], booksCents: 0 }).status, 'empty');
  // Payment leaves checking Feb 28 and lands on the card Mar 1: the card's books already show it, the card's statement does not.
  const r = reconcileMonth({
    accountId: 1, month: '2027-02', monthEnd: '2027-02-28', goLive: GO,
    statements: [{ date: '2027-03-01', balanceCents: -50000 + 30000, source: 'ofx' }],
    rows: [{ id: 5, postedDate: '2027-03-01', amountCents: 30000, pending: false, matchStatus: 'matched', description: 'payment' }],
    booksCents: -20000, transfers: [{ txnId: 5, postedDate: '2027-03-01', amountCents: 30000, partnerPostedDate: '2027-02-28' }],
  });
  assert.equal(r.statementCents, -50000);
  assert.equal(r.unexplainedCents, 0);
  assert.equal(r.status, 'explained');
});
