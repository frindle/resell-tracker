// Pure tests for splitting a bank row: validation, merging, and the postings a split row makes. Made-up data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSplit, mergeLinks, MAX_SPLIT_PARTS } from './split.ts';
import { desiredBankEntries, type BankAcctForBooks } from '../bankPostings.ts';
import { assertBalanced } from '../ledger.ts';
import { remainingChargeCents, orderCovered, type MatchOrder } from '../match.ts';

const CATS = ['postage', 'supplies'];
const check = (raw: unknown, total: number, credit = false) => checkSplit(raw, total, credit, CATS);
const err = (raw: unknown, total: number, credit = false) => { const r = check(raw, total, credit); assert.equal(r.ok, false); return r.ok ? '' : r.error; };

test('a split must have two or more parts that add up to the row exactly', () => {
  assert.match(err([{ cents: 100, kind: 'personal' }], 100), /at least two/);
  assert.match(err('x', 100), /parts of the split/);
  assert.match(err([{ cents: 5000, kind: 'order', orderId: 1 }, { cents: 4000, kind: 'personal' }], 10000), /add up to 9000 cents but the transaction is 10000/);
  assert.match(err([{ cents: 5000, kind: 'order', orderId: 1 }, { cents: 6000, kind: 'personal' }], 10000), /11000/);
  assert.match(err(Array(MAX_SPLIT_PARTS + 1).fill({ cents: 1, kind: 'personal' }), MAX_SPLIT_PARTS + 1), /at most/);
});

test('amounts are whole positive cents; targets are checked', () => {
  const p = { cents: 100, kind: 'personal' };
  for (const c of [0, -5, 1.5, '100', null, Number.NaN]) assert.match(err([{ ...p, cents: c }, p], 200), /whole number of cents/);
  assert.match(err([{ cents: 100, kind: 'order' }, p], 200), /order number or #id/);
  assert.match(err([{ cents: 100, kind: 'order', orderId: 0 }, p], 200), /order number or #id/);
  assert.match(err([{ cents: 100, kind: 'order', returnId: 3 }, p], 200), /order number or #id/); // a charge pays an order
  assert.match(err([{ cents: 100, kind: 'cost', category: 'nope' }, p], 200), /unknown category/);
  assert.match(err([{ cents: 100, kind: 'cost', category: 'postage', businessPct: 101 }, p], 200), /businessPct/);
  assert.match(err([{ cents: 100, kind: 'cashback' }, p], 200), /choose an order/);
  assert.match(err([null, p], 100), /not a part/);
});

test('a credit takes order refunds and Personal, not cost entries', () => {
  assert.match(err([{ cents: 100, kind: 'cost', category: 'postage' }, { cents: 100, kind: 'personal' }], 200, true), /debit/);
  const r = check([{ cents: 700, kind: 'order', returnId: 4 }, { cents: 300, kind: 'personal' }], 1000, true);
  assert.deepEqual(r, { ok: true, parts: [{ cents: 700, kind: 'order', returnId: 4 }, { cents: 300, kind: 'personal' }] });
});

test('same-target parts merge; different costs and orders stay apart', () => {
  const r = check([
    { cents: 1000, kind: 'personal' }, { cents: 2000, kind: 'order', orderId: 5 }, { cents: 500, kind: 'personal' }, { cents: 700, kind: 'order', orderId: 5 },
    { cents: 300, kind: 'cost', category: 'postage' }, { cents: 200, kind: 'cost', category: 'postage', business: 'resell', businessPct: 100 },
    { cents: 400, kind: 'cost', category: 'supplies' }, { cents: 100, kind: 'order', orderNumber: ' ZZ-1 ' },
  ], 5200);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.parts.map(p => [p.kind, p.cents, p.orderId ?? p.orderNumber ?? p.category]), [
    ['personal', 1500, undefined], ['order', 2700, 5], ['cost', 500, 'postage'], ['cost', 400, 'supplies'], ['order', 100, 'ZZ-1'],
  ]);
  assert.deepEqual(mergeLinks([{ kind: 'order_charge', refId: 5, amountCents: 100 }, { kind: 'order_charge', refId: 6, amountCents: 50 }, { kind: 'order_charge', refId: 5, amountCents: 20 }]),
    [{ kind: 'order_charge', refId: 5, amountCents: 120 }, { kind: 'order_charge', refId: 6, amountCents: 50 }]);
});

// ---- postings ----
const accts: BankAcctForBooks[] = [{ id: 1, creditCardId: 7, ledgerAccountId: null }, { id: 2, creditCardId: null, ledgerAccountId: 50 }, { id: 3, creditCardId: null, ledgerAccountId: null }];
const GO = '2027-01-01';
const row = (id: number, accountId: number, amountCents: number, postedDate = '2027-02-04') => ({ id, accountId, postedDate, amountCents, pending: false, description: `row ${id}` });
const sum = (e: { lines: { amountCents: number }[] }) => e.lines.reduce((a, l) => a + l.amountCents, 0);
const post = (rows: ReturnType<typeof row>[], links: { txnId: number; kind: string; refId: number; amountCents: number }[], orderDays = new Map<number, string>()) =>
  desiredBankEntries({ rows, links, accounts: accts, orderDays, goLive: GO });

test('split debit: the order part posts nothing, the personal part is an owner draw for its part only, a cost part posts nothing from the row', () => {
  const d = post([row(1, 1, -34683)], [
    { txnId: 1, kind: 'order_charge', refId: 9, amountCents: 20000 }, { txnId: 1, kind: 'personal', refId: 0, amountCents: 9683 }, { txnId: 1, kind: 'cost', refId: 3, amountCents: 5000 },
  ], new Map([[9, '2027-02-03']]));
  assert.equal(d.length, 1);
  assert.equal(d[0].sourceKey, 'bank:1');
  assert.deepEqual(d[0].lines.map(l => [l.account, l.amountCents]), [['owner_draws', 9683], ['card:7', -9683]]);
  for (const e of d) assertBalanced(e.lines);
});

test('split debit with a pre-go-live order part: opening balance equity for that part, a draw for the personal part; both balanced', () => {
  const d = post([row(1, 2, -10000, '2027-01-05')], [
    { txnId: 1, kind: 'order_charge', refId: 9, amountCents: 6000 }, { txnId: 1, kind: 'personal', refId: 0, amountCents: 4000 },
  ], new Map([[9, '2026-12-20']]));
  assert.deepEqual(d.map(e => e.sourceKey).sort(), ['bank:1', 'bank:1:opening']);
  const open = d.find(e => e.sourceKey === 'bank:1:opening')!;
  assert.deepEqual(open.lines.map(l => [l.account, l.amountCents]), [['opening_balance_equity', 6000], [50, -6000]]);
  for (const e of d) assertBalanced(e.lines);
  assert.equal(d.reduce((a, e) => a + e.lines.filter(l => l.account === 50).reduce((x, l) => x + l.amountCents, 0), 0), -10000); // the account moves by the whole row
});

test('split credit: a refund part posts nothing, the personal part is an owner contribution', () => {
  const d = post([row(1, 2, 5000)], [{ txnId: 1, kind: 'order_refund', refId: 4, amountCents: 3000 }, { txnId: 1, kind: 'personal', refId: 0, amountCents: 2000 }]);
  assert.equal(d.length, 1);
  assert.deepEqual(d[0].lines.map(l => [l.account, l.amountCents]), [[50, 2000], ['owner_contributions', -2000]]);
  assert.equal(sum(d[0]), 0);
});

test('an order part shrinks what is left to charge on that order', () => {
  const o: MatchOrder = { id: 9, platform: 'Acme', orderNumber: null, orderDate: '2027-02-01', cardId: 7, cost: 200, shippingCost: 0, insuranceCost: 0, taxAmount: 0, subtotalAmount: 200, cancelled: false };
  assert.equal(remainingChargeCents(o).min, 20000);
  const part = { ...o, linkedCents: 12000 };
  assert.deepEqual([remainingChargeCents(part).min, orderCovered(part)], [8000, false]);
  assert.equal(orderCovered({ ...o, linkedCents: 20000 }), true);
});
