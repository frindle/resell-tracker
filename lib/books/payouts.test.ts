// Pure tests for P3 step 3c: deposits to payouts (matching, auto-accept rule, allocation), payout postings, shortfall and aging review.
// Made-up data only. The DB-backed parts (links, alias learning, auto-accept, undo, lock gate) are in bank/payouts.db.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestDeposits, suggestAll, depositAutoOption, certainDepositOption, allocateDeposit, payeeToken, genericPayee, type MatchPayout, type MatchTxn, type DepositSuggestion } from './match.ts';
import { desiredBankEntries, type BankAcctForBooks } from './bankPostings.ts';
import { clearedByOrder, openDepositShortfalls, agingByBuyer, parseShort, shortNote, isPreFeed, goLiveCheckSum, goLiveCheckStart, inGoLiveWindow } from './payoutReview.ts';
import { MemoryStore } from './memoryStore.ts';
import { applyDesired } from './reconcile.ts';

const U = 1;
const GO = '2027-01-01';
const NOW = new Date('2027-03-20T20:00:00Z');
const DEP = new Set([2]);
let nid = 500;
const dep = (amountCents: number, postedDate: string, description = 'ACH CREDIT BUYERCO 1234', o: Partial<MatchTxn> = {}): MatchTxn =>
  ({ id: nid++, accountId: 2, postedDate, amountCents, description, matchStatus: 'unmatched', ...o });
const po = (orderId: number, buyerId: number | null, paidDay: string, openCents: number, paidCents = openCents): MatchPayout => ({ orderId, buyerId, paidDay, paidCents, openCents });
const runAll = (t: MatchTxn, payouts: MatchPayout[], aliases: [string, number][] = []): DepositSuggestion | undefined =>
  suggestDeposits([t], DEP, payouts, new Map(aliases)).find(s => s.txnId === t.id);
const run = runAll;
const ids = (s: DepositSuggestion | undefined) => s?.options.map(o => o.parts.map(p => p.orderId));

test('payee token: uppercase, dates and digits stripped, whitespace collapsed; too short is no token', () => {
  assert.equal(payeeToken('ach credit  BuyerCo 04/12 ref 98765'), 'ACH CREDIT BUYERCO REF');
  assert.equal(payeeToken('BUYERCO PAYMENT 2027-03-04 #77'), 'BUYERCO PAYMENT');
  assert.equal(payeeToken('12 34'), '');
});

test('deposit: one order, exact, any age; a different amount is not a single', () => {
  const t = dep(5000, '2027-03-01');
  assert.deepEqual(ids(run(t, [po(1, 1, '2026-01-02', 5000), po(2, 1, '2027-02-20', 4000)])), [[1]]);
  assert.equal(run(dep(4000, '2027-03-01'), [po(1, 1, '2027-02-20', 5000)]), undefined);
});

test('deposit: all of one buyer\'s orders paid the same day, exact; other days do not make a batch', () => {
  const t = dep(10000, '2027-03-01');
  const ps = [po(1, 1, '2027-02-20', 4000), po(2, 1, '2027-02-20', 6000), po(3, 1, '2027-02-10', 3000)];
  const s = run(t, ps);
  assert.equal(s?.options[0].how, 'batch');
  assert.deepEqual(ids(s), [[1, 2]]);
  // 4000 + 6000 on different days is not a same-day batch, but it is a subset within 30 days
  assert.equal(run(dep(10000, '2027-03-01'), [po(1, 1, '2027-02-20', 4000), po(2, 1, '2027-02-21', 6000)])?.options[0].how, 'subset');
  // two buyers' orders on one day never batch together
  assert.equal(run(dep(10000, '2027-03-01'), [po(1, 1, '2027-02-20', 4000), po(2, 2, '2027-02-20', 6000)]), undefined);
});

test('deposit: a subset of one buyer\'s orders paid in the 30 days before; older orders are out; one buyer only', () => {
  const ps = [po(1, 1, '2027-02-10', 3000), po(2, 1, '2027-02-12', 5000), po(3, 1, '2027-02-15', 7000)];
  const s = run(dep(8000, '2027-03-01'), ps);
  assert.equal(s?.options[0].how, 'subset');
  assert.deepEqual(ids(s), [[1, 2]]);
  assert.equal(run(dep(8000, '2027-03-01'), [po(1, 1, '2027-01-20', 3000), po(2, 1, '2027-02-12', 5000)]), undefined); // order 1 is 40 days old
  assert.equal(run(dep(8000, '2027-03-01'), [po(1, 1, '2027-02-10', 3000), po(2, 2, '2027-02-12', 5000)]), undefined); // two buyers
});

test('deposit: two different working subsets stay suggested as two options', () => {
  const ps = [po(1, 1, '2027-02-10', 3000), po(2, 1, '2027-02-11', 5000), po(3, 1, '2027-02-12', 2000), po(4, 1, '2027-02-13', 6000)];
  const s = run(dep(8000, '2027-03-01', 'ACH CREDIT BUYERCO'), ps, [['ACH CREDIT BUYERCO', 1]]);
  assert.deepEqual(ids(s), [[1, 2], [3, 4]]);
  assert.equal(depositAutoOption({ kind: 'deposit', buyerId: s!.buyerId, aliased: s!.aliased, options: s!.options }), null);
});

test('deposit: an alias narrows the search to that buyer; without one every buyer is a candidate', () => {
  const ps = [po(1, 2, '2027-02-20', 5000), po(2, 1, '2027-02-21', 5000)];
  assert.deepEqual(ids(run(dep(5000, '2027-03-01'), ps)), [[1], [2]]); // no alias: both buyers offered
  const s = run(dep(5000, '2027-03-01'), ps, [[payeeToken('ACH CREDIT BUYERCO 1234'), 1]]);
  assert.deepEqual(ids(s), [[2]]);
  assert.equal(s?.aliased, true);
  assert.equal(s?.buyerId, 1);
});

test('generic channels: Zelle, PayPal, checks, transfers are generic; ACH names and words that only contain CHECK are not', () => {
  for (const d of ['ZELLE FROM JOHN DOE 12345', 'Zelle payment from BuyerCo', 'PAYPAL TRANSFER 1234', 'VENMO CASHOUT', 'Cash App deposit',
    'MOBILE DEPOSIT 0412', 'REMOTE DEP', 'DEPOSIT CHECK #1234', 'CHK DEP', 'ATM DEPOSIT', 'BRANCH DEPOSIT', 'ONLINE TRANSFER FROM SAV 1234',
    'TRANSFER FROM CHECKING', 'APPLE CASH TRANSFER', 'E-DEPOSIT 1234']) assert.equal(genericPayee(d), true, d);
  for (const d of ['ACH CREDIT BUYERCO 1234', 'BUYERCO PAYMENT DIRECT DEP', 'CHECKCARD REFUND BUYERCO', 'CHECKING INTEREST', 'BFMR PAYOUT ACH'])
    assert.equal(genericPayee(d), false, d);
});

test('deposit: a generic channel never narrows, even when its token has an alias; every buyer stays a candidate and nothing auto-accepts', () => {
  const ps = [po(1, 2, '2027-02-20', 5000), po(2, 1, '2027-02-21', 5000)];
  const z = 'ZELLE FROM BUYERCO';
  const s = run(dep(5000, '2027-03-01', z), ps, [[payeeToken(z), 1]]);
  assert.deepEqual(ids(s), [[1], [2]]);
  assert.equal(s?.aliased, false);
  const one = run(dep(5000, '2027-03-01', z), [po(2, 1, '2027-02-21', 5000)], [[payeeToken(z), 1]]);
  assert.equal(depositAutoOption({ kind: 'deposit', buyerId: one!.buyerId, aliased: one!.aliased, options: one!.options }), null);
});

test('deposit: a subset 0-3% above the deposit is a near miss with a shortfall; 4% above is nothing', () => {
  const known: [string, number][] = [[payeeToken('ACH CREDIT BUYERCO 1234'), 1]];
  const run = (t: MatchTxn, payouts: MatchPayout[]) => runAll(t, payouts, known);
  const s = run(dep(10000, '2027-03-01'), [po(1, 1, '2027-02-20', 10200)]);
  assert.equal(s?.options[0].how, 'near');
  assert.equal(s?.options[0].shortfallCents, 200);
  assert.deepEqual(s?.options[0].parts, [{ orderId: 1, cents: 10000 }]);
  assert.equal(run(dep(10000, '2027-03-01'), [po(1, 1, '2027-02-20', 10300)])?.options[0].shortfallCents, 300); // exactly 3% is in
  assert.equal(run(dep(10000, '2027-03-01'), [po(1, 1, '2027-02-20', 10301)]), undefined);
  assert.equal(run(dep(10000, '2027-03-01'), [po(1, 1, '2027-02-20', 10400)]), undefined);
  // two orders together are 2% over
  const two = run(dep(10000, '2027-03-01'), [po(1, 1, '2027-02-20', 6000), po(2, 1, '2027-02-21', 4200)]);
  assert.equal(two?.options[0].how, 'near');
  assert.deepEqual(ids(two), [[1, 2]]);
  // an exact hit wins over a near miss
  assert.equal(run(dep(10000, '2027-03-01'), [po(1, 1, '2027-02-20', 10200), po(2, 1, '2027-02-21', 10000)])?.options[0].how, 'single');
});

test('deposit: a payee not tied to a buyer gets no near miss (another group\'s orders would be a guess), only exact sums', () => {
  const ps = [po(1, 4, '2027-02-20', 6000), po(2, 4, '2027-02-21', 4200)];
  assert.equal(runAll(dep(10000, '2027-03-01', 'ACH: OTHER PAYER'), ps), undefined);
  assert.deepEqual(ids(runAll(dep(10200, '2027-03-01', 'ACH: OTHER PAYER'), ps)), [[1, 2]]);
});

test('deposit: pieces. An order stays open until its links reach the paid amount, so a second deposit finds the rest', () => {
  const links = [{ txnId: 1, kind: 'payout', refId: 9, amountCents: 6000, note: 'short=4000' }, { txnId: 1, kind: 'payout_shortfall', refId: 9, amountCents: 4000, note: 'shortfall:more' }];
  assert.equal(clearedByOrder(links).get(9), 6000); // "more coming" clears nothing
  const open = 10000 - (clearedByOrder(links).get(9) ?? 0);
  assert.deepEqual(ids(run(dep(4000, '2027-03-10'), [po(9, 1, '2027-02-20', open, 10000)])), [[9]]);
  const second = [...links, { txnId: 2, kind: 'payout', refId: 9, amountCents: 4000, note: null }];
  assert.equal(10000 - (clearedByOrder(second).get(9) ?? 0), 0); // paid in full: no longer offered
  const fee = [{ txnId: 1, kind: 'payout', refId: 9, amountCents: 9700, note: 'short=300' }, { txnId: 1, kind: 'payout_shortfall', refId: 9, amountCents: 300, note: 'shortfall:fee' }];
  assert.equal(clearedByOrder(fee).get(9), 10000); // a fee clears the order
});

test('deposit: an order claimed by one suggestion is still offered to another until a link exists (the caller claims)', () => {
  const ps = [po(1, 1, '2027-02-20', 5000)];
  const a = dep(5000, '2027-03-01'), b = dep(5000, '2027-03-02');
  const out = suggestDeposits([a, b], DEP, ps, new Map());
  assert.equal(out.length, 2);
});

test('deposit: only credits on deposit accounts, only open rows, only positive', () => {
  const ps = [po(1, 1, '2027-02-20', 5000)];
  assert.equal(run(dep(5000, '2027-03-01', 'X', { accountId: 1 }), ps), undefined);
  assert.equal(run(dep(5000, '2027-03-01', 'X', { matchStatus: 'matched' }), ps), undefined);
  assert.equal(run(dep(-5000, '2027-03-01'), ps), undefined);
});

test('auto-accept: a known payee with one exact answer, in all three exact cases; never without the alias, never a near miss', () => {
  const alias: [string, number][] = [[payeeToken('ACH CREDIT BUYERCO'), 1]];
  const auto = (t: MatchTxn, ps: MatchPayout[], al = alias) => {
    const s = run(t, ps, al);
    return s ? depositAutoOption({ kind: 'deposit', buyerId: s.buyerId, aliased: s.aliased, options: s.options }) : null;
  };
  const single = [po(1, 1, '2027-02-20', 5000)];
  const batch = [po(1, 1, '2027-02-20', 2000), po(2, 1, '2027-02-20', 3000)];
  const subset = [po(1, 1, '2027-02-10', 2000), po(2, 1, '2027-02-12', 3000), po(3, 1, '2027-02-14', 9000)];
  for (const [ps, how] of [[single, 'single'], [batch, 'batch'], [subset, 'subset']] as const) {
    const t = dep(5000, '2027-03-01', 'ACH CREDIT BUYERCO');
    assert.equal(auto(t, ps)?.how, how, `${how} with the alias`);
    assert.equal(auto(t, ps, []), null, `${how} without the alias stays suggested`);
  }
  assert.equal(auto(dep(10000, '2027-03-01', 'ACH CREDIT BUYERCO'), [po(1, 1, '2027-02-20', 10200)]), null); // near miss
  assert.equal(auto(dep(5000, '2027-03-01', 'ACH CREDIT BUYERCO'), [po(1, 1, '2027-02-20', 5000), po(2, 1, '2027-02-21', 5000)]), null); // two answers
});

test('allocate: exact shares each order\'s open amount; a short deposit is shared pro rata and always adds up; too little owed refuses', () => {
  assert.deepEqual(allocateDeposit(10000, [{ orderId: 1, openCents: 4000 }, { orderId: 2, openCents: 6000 }]), [{ orderId: 1, cents: 4000 }, { orderId: 2, cents: 6000 }]);
  const p = allocateDeposit(9999, [{ orderId: 1, openCents: 3333 }, { orderId: 2, openCents: 3333 }, { orderId: 3, openCents: 3334 }])!;
  assert.equal(p.reduce((a, x) => a + x.cents, 0), 9999);
  const q = allocateDeposit(100, [{ orderId: 1, openCents: 101 }, { orderId: 2, openCents: 101 }, { orderId: 3, openCents: 101 }])!;
  assert.equal(q.reduce((a, x) => a + x.cents, 0), 100);
  assert.ok(q.every(x => x.cents <= 101));
  assert.equal(allocateDeposit(10001, [{ orderId: 1, openCents: 10000 }]), null);
});

test('suggestAll: deposits slot in after pairs and before cashback; nothing without extras', () => {
  const t = dep(5000, '2027-03-01');
  const accounts = [{ id: 2, last4: null, creditCardId: null }];
  assert.equal(suggestAll([t], accounts, [], new Map()).size, 0);
  const s = suggestAll([t], accounts, [], new Map(), new Set(), { depositAccountIds: DEP, payouts: [po(1, 1, '2027-02-20', 5000)], aliases: new Map() });
  assert.equal(s.get(t.id)?.kind, 'deposit');
});

// ---- postings ----
const accts: BankAcctForBooks[] = [{ id: 2, creditCardId: null, ledgerAccountId: 50 }, { id: 3, creditCardId: null, ledgerAccountId: null }];
const row = (id: number, accountId: number, postedDate: string, amountCents: number, pending = false) => ({ id, accountId, postedDate, amountCents, pending, description: `dep ${id}` });
const sum = (d: { lines: { amountCents: number }[] }) => d.lines.reduce((s, l) => s + l.amountCents, 0);
function store(): MemoryStore {
  const s = new MemoryStore();
  for (let i = 0; i < 49; i++) s.addAccount(U, { code: `9${i}`, name: `filler ${i}`, type: 'asset', active: false });
  s.addAccount(U, { code: '1010', name: 'Checking', type: 'asset' });
  return s;
}
const entries = (links: { txnId: number; kind: string; refId: number; amountCents: number; note?: string | null }[], rows = [row(1, 2, '2027-02-10', 9700)]) =>
  desiredBankEntries({ rows, links, accounts: accts, orderDays: new Map(), goLive: GO });

test('posting: a deposit is Dr cash, Cr 1100 per order; one balanced entry; a second run posts nothing; undo reverses', async () => {
  const d = entries([{ txnId: 1, kind: 'payout', refId: 7, amountCents: 4000 }, { txnId: 1, kind: 'payout', refId: 8, amountCents: 5700 }]);
  assert.equal(d.length, 1);
  assert.equal(sum(d[0]), 0);
  assert.deepEqual(d[0].lines.map(l => [l.account, l.amountCents, l.orderId ?? null]), [[50, 9700, null], ['undeposited_payouts', -4000, 7], ['undeposited_payouts', -5700, 8]]);
  const s = store();
  await applyDesired(s, U, d, { prefix: 'bank:' }, NOW);
  const r2 = await applyDesired(s, U, d, { prefix: 'bank:' }, NOW);
  assert.deepEqual([r2.posted, r2.reversed], [0, 0]);
  assert.equal(s.balance(U, 'undeposited_payouts'), -9700);
  assert.equal((await applyDesired(s, U, [], { prefix: 'bank:' }, NOW)).reversed, 1);
});

test('posting: shortfall choices. Fee is Dr 6000, Returns is Dr 4100, both Cr 1100; More coming posts nothing extra', async () => {
  const base = { txnId: 1, kind: 'payout', refId: 7, amountCents: 9700, note: 'short=300' };
  const fee = entries([base, { txnId: 1, kind: 'payout_shortfall', refId: 7, amountCents: 300, note: 'shortfall:fee' }]);
  assert.equal(sum(fee[0]), 0);
  assert.deepEqual(fee[0].lines.map(l => [l.account, l.amountCents]), [[50, 9700], ['undeposited_payouts', -9700], ['exp_commissions', 300], ['undeposited_payouts', -300]]);
  const ret = entries([base, { txnId: 1, kind: 'payout_shortfall', refId: 7, amountCents: 300, note: 'shortfall:returns' }]);
  assert.equal(sum(ret[0]), 0);
  assert.deepEqual(ret[0].lines.map(l => [l.account, l.amountCents]).slice(2), [['returns_allowances', 300], ['undeposited_payouts', -300]]);
  const more = entries([base, { txnId: 1, kind: 'payout_shortfall', refId: 7, amountCents: 300, note: 'shortfall:more' }]);
  assert.deepEqual(more[0].lines.map(l => [l.account, l.amountCents]), [[50, 9700], ['undeposited_payouts', -9700]]);
  const s = store();
  await applyDesired(s, U, fee, { prefix: 'bank:' }, NOW);
  assert.equal(s.balance(U, 'exp_commissions'), 300);
  assert.equal(s.balance(U, 'undeposited_payouts'), -10000);
});

test('posting: a payout deposit on an unmapped account, a pending row, or a row before go-live posts nothing', () => {
  const l = [{ txnId: 1, kind: 'payout', refId: 7, amountCents: 9700 }];
  assert.equal(entries(l, [row(1, 3, '2027-02-10', 9700)]).length, 0);
  assert.equal(entries(l, [row(1, 2, '2027-02-10', 9700, true)]).length, 0);
  assert.equal(entries(l, [row(1, 2, '2026-12-30', 9700)]).length, 0);
});

test('posting: a deposit and a Darkbloom piece on the same account each post their own balanced entry', () => {
  const d = entries([{ txnId: 1, kind: 'darkbloom', refId: 0, amountCents: 900 }, { txnId: 2, kind: 'payout', refId: 7, amountCents: 500 }], [row(1, 2, '2027-02-10', 900), row(2, 2, '2027-02-11', 500)]);
  assert.equal(d.length, 2);
  assert.ok(d.every(e => sum(e) === 0));
});

// ---- review ----
test('shortfall notes round-trip; a deposit is an open shortfall until each short order is classified', () => {
  assert.equal(shortNote(0), undefined);
  assert.equal(parseShort(shortNote(250)), 250);
  assert.equal(parseShort(null), 0);
  const links = [
    { txnId: 1, kind: 'payout', refId: 7, amountCents: 900, note: 'short=100' },
    { txnId: 1, kind: 'payout', refId: 8, amountCents: 500, note: null },
    { txnId: 2, kind: 'payout', refId: 9, amountCents: 800, note: 'short=50' },
    { txnId: 2, kind: 'payout_shortfall', refId: 9, amountCents: 50, note: 'shortfall:fee' },
  ];
  assert.deepEqual(openDepositShortfalls(links), [{ txnId: 1, shortCents: 100, orders: [{ orderId: 7, shortCents: 100 }] }]);
});

test('aging: orders paid over 21 days ago with an open amount, grouped by buyer, oldest group first', () => {
  const o = (orderId: number, buyerId: number | null, paidDay: string, openCents: number, paidCents = openCents) => ({ orderId, buyerId, paidDay, openCents, paidCents });
  const g = agingByBuyer([o(1, 1, '2027-02-20', 100), o(2, 1, '2027-02-25', 50, 100), o(3, 2, '2027-02-10', 70), o(4, 2, '2027-03-05', 90), o(5, 3, '2027-02-01', 0, 40)], '2027-03-20');
  assert.deepEqual(g.map(x => [x.buyerId, x.totalCents, x.oldestDay]), [[2, 70, '2027-02-10'], [1, 150, '2027-02-20']]);
  assert.equal(g[1].orders[1].partial, true);
  // exactly 21 days is not yet overdue
  assert.deepEqual(agingByBuyer([o(1, 1, '2027-02-27', 100)], '2027-03-20'), []);
});

// ---- BuyingGroup pre-scan bonus ----
const BG = new Map([['ACH CREDIT BUYERCO', 1]]);
const bgRun = (t: MatchTxn, payouts: MatchPayout[], bonusIds = new Set([1]), aliases = BG) => suggestDeposits([t], DEP, payouts, aliases, [], bonusIds).find(s => s.txnId === t.id);

test('bonus: 39805 for one 39800 order, and 79610 for two 39800 orders, from a BuyingGroup payee', () => {
  const one = bgRun(dep(39805, '2027-03-03'), [po(101, 1, '2027-03-01', 39800)]);
  assert.equal(one?.options.length, 1);
  assert.deepEqual([one!.options[0].how, one!.options[0].bonusCents, one!.options[0].shortfallCents, one!.options[0].parts], ['bonus', 5, 0, [{ orderId: 101, cents: 39800 }]]);
  const two = bgRun(dep(79610, '2027-03-03'), [po(101, 1, '2027-03-01', 39800), po(102, 1, '2027-03-01', 39800)]);
  assert.deepEqual([two!.options[0].how, two!.options[0].bonusCents, two!.options[0].parts.map(p => p.cents)], ['bonus', 10, [39800, 39800]]);
  const three = bgRun(dep(120004, '2027-03-03'), [po(101, 1, '2027-03-01', 50000), po(102, 1, '2027-03-01', 40000), po(103, 1, '2027-03-02', 30000)]);
  assert.deepEqual([three!.options[0].bonusCents, three!.options[0].parts.length], [4, 3]);
});

test('bonus: at most 5 cents an order, at least 1, never a non-BuyingGroup payee, exact searches first, near misses after', () => {
  const o = [po(101, 1, '2027-03-01', 39800)];
  assert.notEqual(bgRun(dep(39806, '2027-03-03'), o)?.options[0]?.how, 'bonus'); // 6 cents on one order
  assert.equal(bgRun(dep(39800, '2027-03-03'), o)?.options[0].how, 'single'); // no bonus: the exact search wins
  assert.notEqual(bgRun(dep(39805, '2027-03-03'), o, new Set())?.options[0]?.how, 'bonus'); // payee is not BuyingGroup
  assert.notEqual(bgRun(dep(39805, '2027-03-03'), o, new Set([1]), new Map())?.options[0]?.how, 'bonus'); // unknown payee
});

test('bonus: a labeled BuyingGroup payment (a total, no orders) finds orders plus a bonus among the orders the group paid', () => {
  const t = dep(39805, '2027-03-03');
  const g = { id: 1, group: 'bg', ref: 'bg:PAY-9', buyerId: 1, buyerName: 'BuyingGroup', paidDay: '2027-03-02', amountCents: 39805, orders: [] };
  const paid = { ...po(101, 1, '2027-03-01', 39800), groupPaid: true };
  const [s] = suggestDeposits([t], DEP, [paid], BG, [g]);
  assert.deepEqual([s.fromGroup, s.options[0].how, s.options[0].bonusCents, s.options[0].payment], [true, 'bonus', 5, 'bg:PAY-9']);
  // an order the group has not paid is not searched
  assert.equal(suggestDeposits([t], DEP, [{ ...paid, groupPaid: false }], BG, [g])[0]?.options[0]?.how === 'bonus', false);
  // another group's labeled payment gets no bonus
  assert.equal(suggestDeposits([t], DEP, [{ ...paid, buyerId: 5 }], new Map([['ACH CREDIT BUYERCO', 5]]), [{ ...g, group: 'other', buyerId: 5 }])[0]?.options[0]?.how === 'bonus', false);
});

test('bonus: the link posts the bonus to Other income and the deposit balances; the orders clear 1100 in full', async () => {
  const d = entries([
    { txnId: 1, kind: 'payout', refId: 7, amountCents: 4000 }, { txnId: 1, kind: 'payout', refId: 8, amountCents: 5695 },
    { txnId: 1, kind: 'payout_bonus', refId: 7, amountCents: 5 },
  ], [row(1, 2, '2027-02-10', 9700)]);
  assert.equal(d.length, 1);
  assert.equal(sum(d[0]), 0);
  assert.deepEqual(d[0].lines.map(l => [l.account, l.amountCents, l.orderId ?? null]), [[50, 9700, null], ['undeposited_payouts', -4000, 7], ['undeposited_payouts', -5695, 8], ['other_income', -5, 7]]);
  const s = store();
  await applyDesired(s, U, d, { prefix: 'bank:' }, NOW);
  assert.equal(s.balance(U, 'other_income'), -5);
  assert.equal(s.balance(U, 'undeposited_payouts'), -9695);
  assert.equal(clearedByOrder([{ txnId: 1, kind: 'payout', refId: 7, amountCents: 4000, note: null }, { txnId: 1, kind: 'payout_bonus', refId: 7, amountCents: 5, note: null }]).get(7), 4000);
});

// ---- BuyingGroup receipts: the payout day and 5 cents a receipt ----
const rpo = (orderId: number, payoutDay: string, openCents: number): MatchPayout => ({ ...po(orderId, 1, '2027-02-01', openCents), groupPaid: true, payoutDay });

test('receipts: two receipts paid out the same day become one deposit of their sum plus 5 cents each', () => {
  const ps = [rpo(1, '2027-03-02', 35200), rpo(2, '2027-03-02', 85800), rpo(3, '2027-03-01', 45800), rpo(4, '2027-02-10', 75500)];
  const s = bgRun(dep(121010, '2027-03-03'), ps);
  assert.equal(s?.options.length, 1);
  assert.deepEqual([s!.options[0].how, s!.options[0].bonusCents, s!.options[0].byPayoutDay, s!.options[0].parts.map(p => p.orderId)], ['bonus', 10, true, [1, 2]]);
  // one receipt, 0-3 days later
  assert.deepEqual(bgRun(dep(45805, '2027-03-04'), ps)?.options.map(o => o.parts.map(p => p.orderId)), [[3]]);
  // the credit day of an order does not pull it in: only the payout day counts (order 4 paid out 19 days before)
  assert.equal(bgRun(dep(75505, '2027-03-03'), ps)?.options[0]?.byPayoutDay, undefined);
});

test('receipts: a deposit before the payout day, or the wrong amount of bonus, is not matched; 1-4 cents an order is the fallback', () => {
  const ps = [rpo(1, '2027-03-05', 35200)];
  assert.equal(bgRun(dep(35205, '2027-03-03'), ps)?.options[0]?.byPayoutDay, undefined);
  const t = dep(35203, '2027-03-06');
  assert.deepEqual([bgRun(t, ps)?.options[0].bonusCents, bgRun(t, ps)?.options[0].byPayoutDay], [3, true]);
  assert.notEqual(bgRun(dep(35205, '2027-03-06'), ps, new Set())?.options[0]?.how, 'bonus'); // not a BuyingGroup payee
});

test('receipts: a unique receipt set is certain, but not when it is contended or the day is out of range', () => {
  const ps = [rpo(1, '2027-03-02', 35200), rpo(2, '2027-03-02', 85800)];
  const t = dep(121010, '2027-03-03');
  const s = bgRun(t, ps)!;
  const sg = { kind: 'deposit' as const, buyerId: s.buyerId, aliased: s.aliased, options: s.options };
  const by = new Map(ps.map(p => [p.orderId, p]));
  assert.equal(certainDepositOption(sg, t.postedDate, by, () => false)?.byPayoutDay, true);
  assert.equal(certainDepositOption(sg, t.postedDate, by, id => id === 2), null);
  assert.equal(certainDepositOption(sg, '2027-03-07', by, () => false), null);
  assert.equal(certainDepositOption(sg, '2027-03-01', by, () => false), null);
});

test('receipts: a labeled BuyingGroup payment uses the payout day too', () => {
  const t = dep(45805, '2027-03-03');
  const g = { id: 1, group: 'bg', ref: 'bg:PAY-9', buyerId: 1, buyerName: 'BuyingGroup', paidDay: '2027-03-02', amountCents: 45805, orders: [] };
  const [s] = suggestDeposits([t], DEP, [rpo(3, '2027-03-02', 45800)], BG, [g]);
  assert.deepEqual([s.fromGroup, s.options[0].byPayoutDay, s.options[0].payment], [true, true, 'bg:PAY-9']);
});

test('isPreFeed: more than 30 days before the first bank row; boundary and no rows', () => {
  assert.equal(isPreFeed('2026-07-31', '2026-08-31'), true);  // 31 days before
  assert.equal(isPreFeed('2026-08-01', '2026-08-31'), false); // exactly 30 days: still in the check
  assert.equal(isPreFeed('2026-08-15', '2026-08-31'), false);
  assert.equal(isPreFeed('2020-01-01', null), false);         // no bank rows at all
});

test('goLiveCheckSum leaves pre-feed orders out of the sum and counts them apart', () => {
  const o = (orderId: number, paidDay: string, paidCents: number, preFeed: boolean, orderDay = paidDay) => ({ orderId, orderDay, paidDay, paidCents, preFeed });
  const orders = [o(1, '2026-05-01', 10000, true), o(2, '2026-09-10', 5000, false), o(3, '2026-10-01', 3000, false), o(4, '2027-01-05', 9000, false), o(5, '2026-06-01', 4000, true)];
  const r = goLiveCheckSum(orders, '2027-01-01', new Map([[3, 1000], [5, 4000]]));
  assert.deepEqual(r, { ordersCents: 7000, orders: 2, preFeedCents: 10000, preFeedOrders: 1 });
});

test('go-live check window starts 30 days before go-live', () => {
  assert.equal(goLiveCheckStart('2027-01-01'), '2026-12-02');
  assert.equal(inGoLiveWindow('2026-12-01', '2027-01-01'), false);
  assert.equal(inGoLiveWindow('2026-12-02', '2027-01-01'), true);
  assert.equal(inGoLiveWindow('2027-02-01', '2027-01-01'), true);
});
