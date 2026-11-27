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

test('a failed later allocation rolls back the earlier ones, so the order is retried', async () => {
  const { store, links } = fakeStore(
    [{ id: 1, itemDescription: 'Acme Kettle Steel', orderDate: D('2026-11-10') }],
    { bg: [bg(7, 'Acme Kettle Steel', { count: 1, price: 50, dealId: 'd' }), bg(8, 'Acme Kettle Steel', { count: 1, price: 50, dealId: 'd' })] },
  );
  const undone: number[] = [];
  const inner = store.link;
  store.link = async (c, o, q) => { if (c.id === 8) throw new Error('boom'); await inner(c, o, q); };
  store.unlink = async c => { undone.push(c.id); };
  const r = await matchOrdersWith(store, [1], new Map([[1, 2]]), NOW);
  assert.equal(links.length, 1);
  assert.deepEqual(undone, [8, 7]); // the failed candidate first, then the earlier one
  assert.equal(r.linked, 0);
  assert.equal(r.unplaced.length, 1);
});

test('without a rollback a short link is reported as partial', async () => {
  const { store } = fakeStore(
    [{ id: 1, itemDescription: 'Acme Kettle Steel', orderDate: D('2026-11-10') }],
    { bg: [bg(7, 'Acme Kettle Steel', { count: 1, price: 50, dealId: 'd' }), bg(8, 'Acme Kettle Steel', { count: 1, price: 50, dealId: 'd' })] },
  );
  const inner = store.link;
  store.link = async (c, o, q) => { if (c.id === 8) throw new Error('boom'); await inner(c, o, q); };
  const r = await matchOrdersWith(store, [1], new Map([[1, 2]]), NOW);
  assert.equal(r.unplaced[0]?.detail, 'partial');
});

test('two runs at once are serialized: the second sees what the first took', async () => {
  const { store, links } = fakeStore(
    [{ id: 1, itemDescription: 'Acme Kettle Steel', orderDate: D('2026-11-10') }, { id: 2, itemDescription: 'Acme Kettle Steel', orderDate: D('2026-11-10') }],
    { bg: [bg(7, 'Acme Kettle Steel', { count: 1 })] },
  );
  // The store models the database: a linked order or used-up row is no longer offered.
  const claimed = new Set<number>();
  const rowsLoad = store.loadCandidateRows;
  store.loadCandidateRows = async () => { const r = await rowsLoad(); return { ...r, bg: r.bg.map(b => ({ ...b, assignedQty: claimed.size })) }; };
  const inner = store.link;
  store.link = async (c, o, q) => { await new Promise(res => setTimeout(res, 20)); claimed.add(o); await inner(c, o, q); };
  await Promise.all([matchOrdersWith(store, [1], new Map(), NOW), matchOrdersWith(store, [2], new Map(), NOW)]);
  assert.equal(links.length, 1);
});

test('a link that wrote its row and then threw is unlinked too, so the order is retried', async () => {
  const { store } = fakeStore(
    [{ id: 1, itemDescription: 'Acme Kettle Steel', orderDate: D('2026-11-10') }],
    { bg: [bg(7, 'Acme Kettle Steel')] },
  );
  const rows = new Set<number>();
  store.link = async c => { rows.add(c.id); throw new Error('recalc failed'); };
  store.unlink = async c => { rows.delete(c.id); };
  const warn = console.warn; console.warn = () => {};
  try {
    const r = await matchOrdersWith(store, [1], new Map(), NOW);
    assert.equal(rows.size, 0);
    assert.equal(r.linked, 0);
    assert.equal(r.unplaced[0]?.detail, 'write-failed');
  } finally { console.warn = warn; }
});

test('runs through different module copies share one lock', async () => {
  // A second copy of the module (as Next loads per route) must still serialize with the first.
  const spec = './commitmentMatchCore.ts?second-copy';
  const other = await import(spec) as typeof import('./commitmentMatchCore.ts');
  const order = (id: number) => ({ id, itemDescription: 'Acme Kettle Steel', orderDate: D('2026-11-10') });
  const events: string[] = [];
  const mk = (tag: string, id: number) => {
    const { store } = fakeStore([order(id)], { bg: [bg(7, 'Acme Kettle Steel')] });
    store.link = async () => { events.push(`${tag}-start`); await new Promise(res => setTimeout(res, 20)); events.push(`${tag}-end`); };
    return store;
  };
  await Promise.all([
    matchOrdersWith(mk('a', 1), [1], new Map(), NOW),
    other.matchOrdersWith(mk('b', 2), [2], new Map(), NOW),
  ]);
  assert.deepEqual(events, ['a-start', 'a-end', 'b-start', 'b-end']);
});
