import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findUncharged, type UnchargedInput } from './uncharged.ts';

const base = (o: Partial<UnchargedInput>): UnchargedInput => ({
  id: 1, platform: 'Amazon', orderNumber: 'A1', orderDate: '2026-10-01', cardId: 5, cost: 50, shippingCost: 0, insuranceCost: 0,
  taxAmount: null, subtotalAmount: null, cancelled: false, item: 'Widget', ...o,
});
const feed = new Map<number, string | null>([[5, '2026-01-01']]);
const run = (orders: UnchargedInput[], charged: [number, number][] = [], f = feed, goLive = '2026-01-01', today = '2026-10-20') =>
  findUncharged(orders, new Map(charged), f, goLive, today);

test('no charge and short are flagged, covered is not', () => {
  const r = run([base({ id: 1 }), base({ id: 2 }), base({ id: 3 })], [[2, 3000], [3, 5000]]);
  assert.deepEqual(r.rows.map(x => [x.orderId, x.status, x.expectedCents, x.chargedCents]), [[1, 'none', 5000, 0], [2, 'short', 5000, 3000]]);
});
test('split shipments are summed; within $1 is not short', () => {
  assert.equal(run([base({})], [[1, 4910]]).rows.length, 0);
  assert.equal(run([base({})], [[1, 4899]]).rows.length, 1);
});
test('exact subtotal+tax expected charge is used when known', () => {
  const r = run([base({ subtotalAmount: 40, taxAmount: 4, shippingCost: 2, cost: 40 })]);
  assert.equal(r.rows[0].expectedCents, 4600);
});
test('window plus lag: recent orders are not judged', () => {
  assert.equal(run([base({ orderDate: '2026-10-10' })]).rows.length, 0); // 10 days old
  assert.equal(run([base({ orderDate: '2026-10-09' })]).rows.length, 1); // 11 days old
});
test('older than go-live, cancelled, or before the feed starts are skipped', () => {
  assert.equal(run([base({ orderDate: '2025-12-31' })]).rows.length, 0);
  assert.equal(run([base({ cancelled: true })]).rows.length, 0);
  assert.equal(run([base({})], [], new Map([[5, '2026-10-02']])).rows.length, 0);
  assert.equal(run([base({})], [], new Map([[5, null]])).rows.length, 0);
});
test('unlinked cards are counted and left out', () => {
  const r = run([base({ cardId: 9 }), base({ id: 2, cardId: null })]);
  assert.deepEqual([r.rows.length, r.unlinked], [0, 1]);
});
