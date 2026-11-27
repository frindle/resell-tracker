import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchOrdersWith, type MatchStore } from './commitmentMatchCore.ts';
import type { Candidate } from './commitmentMatch.ts';

const NOW = Date.parse('2026-11-19T20:00:00Z');
const D = (s: string) => new Date(s + 'T00:00:00Z');

type Order = {
  id: number; itemDescription: string | null; orderDate: Date;
  subtotalAmount?: number | null; cost?: number | null; buyer?: { name: string } | null;
};
function fakeStore(orders: Order[], rows: Partial<Awaited<ReturnType<MatchStore['loadCandidateRows']>>>) {
  const links: { c: Candidate; orderId: number; quantity: number }[] = [];
  const store: MatchStore = {
    loadOrders: async ids => orders.filter(o => ids.includes(o.id)),
    loadCandidateRows: async () => ({ bfmr: [], bg: [], bigsky: [], ...rows }),
    link: async (c, orderId, quantity) => { links.push({ c, orderId, quantity }); },
  };
  return { store, links };
}
const bg = (id: number, dealTitle: string, extra = {}) =>
  ({ id, dealTitle, count: 3, assignedQty: 0, status: 'ACTIVE', expiryDay: null, createdDt: D('2026-11-01'), ...extra });

test('links the one fitting commitment and writes it once', async () => {
  const { store, links } = fakeStore(
    [{ id: 1, itemDescription: 'Acme Kettle Steel', orderDate: D('2026-11-10') }],
    { bg: [bg(7, 'Acme Kettle Steel')] },
  );
  const r = await matchOrdersWith(store, [1], new Map(), NOW);
  assert.equal(r.linked, 1);
  assert.deepEqual(links.map(l => [l.c.group, l.c.id, l.orderId, l.quantity]), [['BG', 7, 1, 1]]);
});

test('units taken by one order come off what the next order sees', async () => {
  const { store, links } = fakeStore(
    [{ id: 1, itemDescription: 'Acme Kettle Steel', orderDate: D('2026-11-10') }, { id: 2, itemDescription: 'Acme Kettle Steel', orderDate: D('2026-11-10') }],
    { bg: [bg(7, 'Acme Kettle Steel', { count: 1 })] },
  );
  const r = await matchOrdersWith(store, [1, 2], new Map(), NOW);
  assert.equal(r.linked, 1);
  assert.deepEqual(r.unplaced, [{ orderId: 2, reason: 'none', detail: 'no-open-rows' }]);
  assert.equal(links.length, 1);
});

test('two fitting commitments: no link, reported as several', async () => {
  const { store, links } = fakeStore(
    [{ id: 1, itemDescription: 'Acme Kettle Steel', orderDate: D('2026-11-10') }],
    { bg: [bg(7, 'Acme Kettle Steel')], bigsky: [{ id: 8, itemName: 'Acme Kettle Steel', commitmentAmount: 2, fulfilled: 0, plannedQty: 0, status: 'UNFULFILLED', dealExpiration: null, dealCreated: D('2026-11-02'), creationDate: null }] },
  );
  const r = await matchOrdersWith(store, [1], new Map(), NOW);
  assert.equal(links.length, 0);
  assert.deepEqual(r.unplaced, [{ orderId: 1, reason: 'several', detail: '2 rows' }]);
});

test('an order dated before the commitment is not linked', async () => {
  const { store, links } = fakeStore(
    [{ id: 1, itemDescription: 'Acme Kettle Steel', orderDate: D('2026-10-20') }],
    { bg: [bg(7, 'Acme Kettle Steel', { createdDt: D('2026-11-01') })] },
  );
  const r = await matchOrdersWith(store, [1], new Map(), NOW);
  assert.equal(links.length, 0);
  assert.equal(r.unplaced[0].reason, 'none');
});

test('(xN) name: not linked without a real quantity, linked with it using that quantity', async () => {
  const order = { id: 1, itemDescription: 'Acme Kettle Steel (x2)', orderDate: D('2026-11-10') };
  const rows = { bg: [bg(7, 'Acme Kettle Steel')] };
  let t = fakeStore([order], rows);
  let r = await matchOrdersWith(t.store, [1], new Map(), NOW);
  assert.deepEqual([t.links.length, r.unplaced[0].reason], [0, 'qty-unknown']);
  t = fakeStore([order], rows);
  r = await matchOrdersWith(t.store, [1], new Map([[1, 2]]), NOW);
  assert.deepEqual(t.links.map(l => l.quantity), [2]);
});

test('a failing write is logged and does not stop the next order', async () => {
  const orders = [{ id: 1, itemDescription: 'Acme Kettle Steel', orderDate: D('2026-11-10') }, { id: 2, itemDescription: 'Zed Toaster Chrome', orderDate: D('2026-11-10') }];
  const links: number[] = [];
  const store: MatchStore = {
    loadOrders: async () => orders,
    loadCandidateRows: async () => ({ bfmr: [], bg: [bg(7, 'Acme Kettle Steel'), bg(8, 'Zed Toaster Chrome')], bigsky: [] }),
    link: async (_c, orderId) => { if (orderId === 1) throw new Error('db down'); links.push(orderId); },
  };
  const warn = console.warn; console.warn = () => {};
  try {
    const r = await matchOrdersWith(store, [1, 2], new Map(), NOW);
    assert.equal(r.linked, 1);
    assert.deepEqual(links, [2]);
  } finally { console.warn = warn; }
});

test('no order ids, or no orders left after the unlinked filter: nothing happens', async () => {
  const { store } = fakeStore([], {});
  assert.deepEqual(await matchOrdersWith(store, [], new Map(), NOW), { linked: 0, unplaced: [], lines: [] });
  assert.deepEqual(await matchOrdersWith(store, [5], new Map(), NOW), { linked: 0, unplaced: [], lines: [] });
});

test('the order total and buyer reach the matcher: units from the price, other groups skipped', async () => {
  const bfmrRow = { id: 9, itemName: 'Acme Kettle Steel', dealTitle: null, qty: 4, status: 'reserved', linkCount: 0, retailPrice: 50 };
  const { store, links } = fakeStore(
    [{ id: 1, itemDescription: 'Acme Kettle Steel', orderDate: D('2026-11-10'), subtotalAmount: 100, cost: 108, buyer: { name: 'BFMR' } }],
    { bfmr: [bfmrRow], bg: [bg(7, 'Acme Kettle Steel', { price: 50 })] },
  );
  const r = await matchOrdersWith(store, [1], new Map(), NOW);
  assert.equal(r.linked, 1);
  assert.deepEqual(links.map(l => [l.c.group, l.c.id, l.quantity]), [['BFMR', 9, 2]]);
});

test('a replaced placeholder name passes its item count: several items without a price are not linked', async () => {
  const { store, links } = fakeStore(
    [{ id: 1, itemDescription: 'Acme Kettle Steel', orderDate: D('2026-11-10') }],
    { bg: [bg(7, 'Acme Kettle Steel')] },
  );
  const r = await matchOrdersWith(store, [1], new Map(), NOW, new Map([[1, 2]]));
  assert.equal(links.length, 0);
  assert.deepEqual(r.unplaced, [{ orderId: 1, reason: 'units-unconfirmed' }]);
});
