import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyActionOrders, paidShortBy, type ActionOrder } from './orderActions.ts';
import { buildActionLines, ACTION_ITEMS_PER_GROUP } from './orderActionLines.ts';
import { buildDigestLines, MAX_LINES, lineLooksPrivate, type DigestCounts } from './digestLines.ts';

const NOW = new Date(2026, 5, 20, 12, 0, 0);
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86400000);

const base: ActionOrder = {
  id: 1, orderNumber: 'X-1', platform: 'Acme', buyerId: 7, buyerName: 'Group A', orderDate: daysAgo(10), cost: 50, salePrice: 80,
  salePriceSynced: false, bgExpectedPayout: null, bgPaidAmount: null, bgPaidAt: null, bgCredited: false, bfmrStatus: null,
  buyerMismatch: false, overdueAt: null, lost: false, locked: false, cancelled: false, trackingNumbers: null,
  trackingSubmittedToBg: false, blockedAddressPattern: null, belowCostAlert: null, bfmrRejectedItems: null, staleOpenReturn: false, delivery: null,
};
const o = (id: number, over: Partial<ActionOrder>): ActionOrder => ({ ...base, id, ...over });
const none = new Map<number, number>();

test('a healthy order is not listed', () => {
  const g = classifyActionOrders([base, o(2, { salePriceSynced: true, bgPaidAmount: 80 })], none, NOW);
  assert.deepEqual([g.dispute.length, g.manual.length, g.review.length], [0, 0, 0]);
});

test('paid short beyond a few cents is a dispute, by the shortfall amount', () => {
  const g = classifyActionOrders([o(1, { bgPaidAmount: 70, bgExpectedPayout: 80 }), o(2, { bgPaidAmount: 79.97, bgExpectedPayout: 80 })], none, NOW);
  assert.equal(g.dispute.length, 1);
  assert.deepEqual([g.dispute[0].orderId, g.dispute[0].code, g.dispute[0].amount], [1, 'paid_short', 10]);
  assert.equal(paidShortBy({ bgPaidAmount: 80, bgExpectedPayout: 80, salePrice: 80, salePriceSynced: false }), 0);
});

test('buyer mismatch, open deposit shortfall and overdue payment are disputes', () => {
  const g = classifyActionOrders([
    o(1, { buyerMismatch: true }),
    o(2, {}),
    o(3, { overdueAt: daysAgo(4) }),
    o(4, { overdueAt: daysAgo(4), bgCredited: true }),
    o(5, { overdueAt: new Date(NOW.getTime() + 86400000) }),
  ], new Map([[2, 1250]]), NOW);
  assert.deepEqual(g.dispute.map(i => [i.orderId, i.code]).sort(), [[1, 'buyer_mismatch'], [2, 'deposit_short'], [3, 'overdue']]);
  assert.equal(g.dispute.find(i => i.orderId === 2)!.amount, 12.5);
});

test('delivered and not credited after the wait is a dispute; a fresh delivery is not', () => {
  const late = { state: 'delivered' as const, daysSinceDelivered: 9, lateReceipt: true };
  const g = classifyActionOrders([o(1, { delivery: late }), o(2, { delivery: { ...late, daysSinceDelivered: 4 } }), o(3, { delivery: late, bgCredited: true })], none, NOW);
  assert.deepEqual(g.dispute.map(i => [i.orderId, i.code, i.ageDays]), [[1, 'delivered_not_credited', 9]]);
});

test('manual handling: stuck tracking, carrier exception, blocked, shipped with no group', () => {
  const g = classifyActionOrders([
    o(1, { buyerName: 'BuyingGroup', trackingNumbers: 'T1' }),
    o(2, { buyerName: 'BuyingGroup', trackingNumbers: 'T2', orderDate: daysAgo(1) }),
    o(3, { delivery: { state: 'exception', daysSinceDelivered: null, lateReceipt: false } }),
    o(4, { blockedAddressPattern: 'rule', cost: 99 }),
    o(5, { buyerId: null, buyerName: null, trackingNumbers: 'T5' }),
    o(6, { buyerName: 'BuyingGroup', trackingNumbers: 'T6', trackingSubmittedToBg: true }),
  ], none, NOW);
  assert.deepEqual(g.manual.map(i => [i.orderId, i.code]), [[4, 'blocked'], [1, 'tracking_not_uploaded'], [3, 'delivery_exception'], [5, 'no_buyer']]);
  assert.equal(g.dispute.length, 0);
});

test('review: below-cost alert, rejected items, stale return', () => {
  const g = classifyActionOrders([o(1, { belowCostAlert: 'x' }), o(2, { bfmrRejectedItems: '[{"name":"a","reason":"b"}]' }), o(3, { bfmrRejectedItems: '[]' }), o(4, { staleOpenReturn: true })], none, NOW);
  assert.deepEqual(g.review.map(i => i.code).sort(), ['below_cost', 'rejected_items', 'stale_return']);
});

test('an order lands once, in its highest group, and cancelled or lost-and-paid ones are skipped', () => {
  const g = classifyActionOrders([
    o(1, { buyerMismatch: true, belowCostAlert: 'x', blockedAddressPattern: 'r' }),
    o(2, { cancelled: true, buyerMismatch: true }),
  ], none, NOW);
  assert.equal(g.dispute.length + g.manual.length + g.review.length, 1);
  assert.equal(g.dispute[0].orderId, 1);
});

test('each group is sorted by money at stake, then age', () => {
  const g = classifyActionOrders([
    o(1, { buyerMismatch: true, salePrice: 20 }), o(2, { buyerMismatch: true, salePrice: 90 }), o(3, { buyerMismatch: true, salePrice: 90, orderDate: daysAgo(30) }),
  ], none, NOW);
  assert.deepEqual(g.dispute.map(i => i.orderId), [3, 2, 1]);
});

test('very old orders drop out unless money is still short', () => {
  const g = classifyActionOrders([o(1, { orderDate: daysAgo(400), buyerMismatch: true }), o(2, { orderDate: daysAgo(400), bgPaidAmount: 1, bgExpectedPayout: 5 })], none, NOW);
  assert.deepEqual(g.dispute.map(i => i.orderId), [2]);
});

test('lines: one per group with counts, ids, ages, "and N more" and the page; no amounts', () => {
  const many = Array.from({ length: 13 }, (_, i) => o(i + 1, { buyerMismatch: true, salePrice: 100 - i }));
  const g = classifyActionOrders([...many, o(50, { blockedAddressPattern: 'r' }), o(51, { belowCostAlert: 'x' })], none, NOW);
  const lines = buildActionLines(g);
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^Dispute with the group: 13 orders \(wrong group paid 13\)\. Biggest: #1 \(Acme Group A, 10d\), #2/);
  assert.match(lines[1], /^Also: #/);
  assert.match(lines[1], / and 3 more\. \/orders\?status=partial,overdue$/);
  assert.equal(lines.slice(0, 2).join('').split('#').length - 1, ACTION_ITEMS_PER_GROUP);
  assert.equal(lines[2], 'Needs handling by hand: 1 order (blocked 1). Biggest: #50 (Acme Group A, 10d). /orders/blocked');
  assert.match(lines[3], /^Needs a look: 1 order \(below cost 1\)\./);
  for (const l of lines) { assert.equal(lineLooksPrivate(l), false, l); assert.ok(Array.from(l).length <= 200); }
});

test('lines: a group name the queue would refuse loses the names, not the counts', () => {
  const g = classifyActionOrders([o(1, { buyerMismatch: true, buyerName: 'pay@example' })], none, NOW);
  const [line] = buildActionLines(g);
  assert.equal(lineLooksPrivate(line), false);
  assert.match(line, /^Dispute with the group: 1 order \(wrong group paid 1\)\./);
});

test('no action orders: no lines, digest unchanged', () => {
  const counts: DigestCounts = { ordersAdded: {}, addedWithoutCard: 0, syncRuns: 0, syncOrdersChanged: 0, cardsSubmitted: 0, waitingToShip: 0, pastShipBy: 0, unseenErrors: 0 };
  const g = classifyActionOrders([base], none, NOW);
  assert.deepEqual(buildDigestLines({ ...counts, actions: g }), buildDigestLines(counts));
});

test('digest: action lines go first, the total stays within the queue limit, and a dispute needs Penn', () => {
  const counts: DigestCounts = { ordersAdded: { Acme: 2 }, addedWithoutCard: 1, syncRuns: 3, syncOrdersChanged: 4, cardsSubmitted: 1, waitingToShip: 2, pastShipBy: 0, unseenErrors: 2 };
  const g = classifyActionOrders([o(1, { buyerMismatch: true }), o(2, { blockedAddressPattern: 'r' }), o(3, { belowCostAlert: 'x' })], none, NOW);
  const { lines, needsYou } = buildDigestLines({ ...counts, actions: g });
  assert.ok(lines[0].startsWith('Dispute with the group'));
  assert.ok(lines[1].startsWith('Needs handling by hand'));
  assert.ok(lines[2].startsWith('Needs a look'));
  assert.equal(lines[3], '2 new orders (Acme).');
  assert.ok(lines.length <= MAX_LINES);
  assert.equal(needsYou, true);
  const review = buildDigestLines({ ...counts, actions: classifyActionOrders([o(3, { belowCostAlert: 'x' })], none, NOW) });
  assert.equal(review.needsYou, false);
});
