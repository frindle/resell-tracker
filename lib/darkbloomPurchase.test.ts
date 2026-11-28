import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEntry, chargeCents, entryRef, entrySig, itemLines, planPush, purchaseStatus, darkbloomAutoPick, isBloomCategory,
  type PurchaseOrder, type PlanInput,
} from './darkbloomPurchase.ts';
import { suggestAll, type MatchOrder, type MatchTxn, type MatchAccount } from './books/match.ts';
import { acceptOptions } from './books/bank/acceptOptions.ts';

const order = (o: Partial<PurchaseOrder> = {}): PurchaseOrder => ({
  id: 7, platform: 'Amazon', orderNumber: '000-0000000-0000000', orderDate: '2026-11-20', cost: 20.58, shippingCost: 0, taxAmount: null, subtotalAmount: null,
  itemDescription: 'Electronics (1 items)', cardLast4: '4242', darkbloomCategory: 'supplies', darkbloomMachineId: null, bloomEntryId: null, bloomPushedSig: null, bloomRev: 0, cancelled: false, ...o,
});

test('amount: cost plus shipping; subtotal plus tax when both are known', () => {
  assert.equal(chargeCents(order()), 2058);
  assert.equal(chargeCents(order({ shippingCost: 4.99 })), 2557);
  assert.equal(chargeCents(order({ subtotalAmount: 19.2, taxAmount: 1.38, shippingCost: 0 })), 2058);
});

test('the email placeholder is not an item; a real title or package items are', () => {
  assert.equal(itemLines('Electronics (1 items)', []), null);
  assert.equal(itemLines(null, []), null);
  assert.deepEqual(itemLines('USB-C cable 2 pack', []), [{ qty: 1, name: 'USB-C cable 2 pack' }]);
  assert.deepEqual(itemLines('Electronics (2 items)', [[{ title: 'Cable', quantity: 2 }], [{ title: 'Cable', quantity: 1 }, { title: 'Hub', quantity: 1 }]]),
    [{ qty: 3, name: 'Cable' }, { qty: 1, name: 'Hub' }]);
});

test('payload: date, amount, vendor, note with qty x name lines, card last4 only, ref, no machine unless hardware', () => {
  const e = buildEntry(order(), [{ qty: 2, name: 'Cable' }]);
  assert.deepEqual(e, {
    kind: 'cost', date: '2026-11-20', amount_cents: 2058, category: 'supplies', vendor: 'Amazon',
    note: 'Order 000-0000000-0000000\n2 × Cable', purpose: 'Paid with card ending 4242', business_pct: 100, ref: 'resell:order:7',
  });
  assert.equal('machine_id' in buildEntry(order({ darkbloomMachineId: 'm4' }), [{ qty: 1, name: 'x' }]), false);
  const h = buildEntry(order({ darkbloomCategory: 'hardware', darkbloomMachineId: 'm4' }), [{ qty: 1, name: 'x' }]);
  assert.equal(h.machine_id, 'm4');
  assert.equal(buildEntry(order({ cardLast4: null }), [{ qty: 1, name: 'x' }]).purpose, 'Darkbloom purchase');
  assert.equal(buildEntry(order({ cardLast4: '42' }), [{ qty: 1, name: 'x' }]).purpose, 'Darkbloom purchase');
  assert.equal(entryRef(7, 2), 'resell:order:7:r2');
  assert.equal(isBloomCategory('interest'), false);
});

const base: PlanInput = { marked: true, cancelled: false, entryId: null, pushedSig: null, lines: [{ qty: 1, name: 'x' }], amountCents: 2058, sig: 's1', url: true, token: true };

test('push decisions: wait for items, pending without key, post once, synced, repost on change, void on unmark', () => {
  assert.deepEqual(planPush({ ...base, lines: null }), { do: 'wait', why: 'items' });
  assert.deepEqual(planPush({ ...base, amountCents: 0 }), { do: 'wait', why: 'amount' });
  assert.deepEqual(planPush({ ...base, token: false }), { do: 'pending', why: 'no-key' });
  assert.deepEqual(planPush({ ...base, url: false }), { do: 'pending', why: 'no-ledger' });
  assert.deepEqual(planPush(base), { do: 'post' });
  assert.deepEqual(planPush({ ...base, entryId: 5, pushedSig: 's1' }), { do: 'synced' });
  assert.deepEqual(planPush({ ...base, entryId: 5, pushedSig: 's0' }), { do: 'repost' });
  assert.deepEqual(planPush({ ...base, marked: false, entryId: 5 }), { do: 'void' });
  assert.deepEqual(planPush({ ...base, cancelled: true, entryId: 5 }), { do: 'void' });
  assert.deepEqual(planPush({ ...base, marked: false }), { do: 'none' });
  assert.deepEqual(planPush({ ...base, marked: false, entryId: 5, token: false }), { do: 'pending', why: 'no-key' });
});

test('an order with an entry id never posts again, whatever else changes', () => {
  for (const sig of ['s1', 's2']) assert.notEqual(planPush({ ...base, entryId: 9, pushedSig: 's1', sig }).do, 'post');
});

test('signature changes with amount, items and card; not with the ref', () => {
  const a = buildEntry(order(), [{ qty: 1, name: 'x' }]);
  assert.equal(entrySig(a), entrySig(buildEntry(order({ bloomRev: 3 }), [{ qty: 1, name: 'x' }])));
  assert.notEqual(entrySig(a), entrySig(buildEntry(order({ cost: 21 }), [{ qty: 1, name: 'x' }])));
  assert.notEqual(entrySig(a), entrySig(buildEntry(order(), [{ qty: 2, name: 'x' }])));
});

test('status text', () => {
  assert.equal(purchaseStatus({ darkbloomCategory: null, bloomEntryId: null, bloomPushNote: null }).state, 'none');
  assert.equal(purchaseStatus({ darkbloomCategory: 'supplies', bloomEntryId: 3, bloomPushNote: null }).state, 'synced');
  assert.equal(purchaseStatus({ darkbloomCategory: 'supplies', bloomEntryId: null, bloomPushNote: 'items' }).state, 'waiting-items');
  assert.equal(purchaseStatus({ darkbloomCategory: 'supplies', bloomEntryId: null, bloomPushNote: 'no-key' }).state, 'pending-push');
  assert.equal(purchaseStatus({ darkbloomCategory: 'supplies', bloomEntryId: null, bloomPushNote: 'auth' }).state, 'pending-push');
});

// ---- bank suggestion ----
const acct: MatchAccount = { id: 1, last4: '4242', creditCardId: 10 };
const mo = (o: Partial<MatchOrder> = {}): MatchOrder => ({ id: 7, platform: 'Amazon', orderNumber: '000-0000000-0000000', orderDate: '2026-11-20', cardId: 10, cost: 20.58, shippingCost: 0, insuranceCost: 0, taxAmount: null, subtotalAmount: null, cancelled: false, ...o });
const txn = (o: Partial<MatchTxn> = {}): MatchTxn => ({ id: 1, accountId: 1, postedDate: '2026-11-22', amountCents: -2058, description: 'AMAZON MKTPL', matchStatus: 'unmatched', ...o });
const lastFours = new Map([[10, new Set(['4242'])]]);

test('a card charge matching a Darkbloom purchase is suggested as a Darkbloom cost, not an order charge', () => {
  const s = suggestAll([txn()], [acct], [], lastFours, new Set(), { darkbloomOrders: [mo()] }).get(1);
  assert.deepEqual(s, { kind: 'darkbloom_cost', orderIds: [7], exact: true });
  const o = acceptOptions(s as never, String);
  assert.deepEqual(o.map(x => x.label), ['Accept as Darkbloom cost']);
});

test('outside the date window or amount, no suggestion; an inexact fit is not auto-pickable', () => {
  assert.equal(suggestAll([txn({ postedDate: '2026-12-20' })], [acct], [], lastFours, new Set(), { darkbloomOrders: [mo()] }).get(1), undefined);
  assert.equal(suggestAll([txn({ amountCents: -5000 })], [acct], [], lastFours, new Set(), { darkbloomOrders: [mo()] }).get(1), undefined);
  const s = suggestAll([txn({ amountCents: -2200 })], [acct], [], lastFours, new Set(), { darkbloomOrders: [mo()] }).get(1);
  assert.equal(s?.kind, 'darkbloom_cost');
  assert.equal(darkbloomAutoPick(s as never), null);
});

test('auto pick needs exactly one order and an exact fit', () => {
  assert.equal(darkbloomAutoPick({ kind: 'darkbloom_cost', orderIds: [7], exact: true }), 7);
  assert.equal(darkbloomAutoPick({ kind: 'darkbloom_cost', orderIds: [7, 8], exact: true }), null);
  assert.equal(darkbloomAutoPick({ kind: 'darkbloom_cost', orderIds: [7], exact: false }), null);
});
