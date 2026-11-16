import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderGaps, fillableGaps, planGapFill, gapFillLine, isUselessDescription, type GapOrder } from './gapFill.ts';

const ADDR = '100 Test St, Springfield, ZZ, 00001, USA';
const o = (x: Partial<GapOrder>): GapOrder => ({
  platform: 'Walmart', orderNumber: '2000000-00000001', itemDescription: 'Laptop', shippingAddress: ADDR, trackingNumbers: null, shipped: false, ...x,
});

test('orderGaps: item, address and tracking', () => {
  assert.deepEqual(orderGaps(o({})), []);
  assert.deepEqual(orderGaps(o({ itemDescription: '', shippingAddress: null })), ['item', 'address']);
  assert.deepEqual(orderGaps(o({ itemDescription: 'walmart.com' })), ['item']);
  assert.deepEqual(orderGaps(o({ shippingAddress: 'Bravo' })), ['address']);
  // Tracking only counts once a shipping email came in.
  assert.deepEqual(orderGaps(o({ shipped: true })), ['tracking']);
  assert.deepEqual(orderGaps(o({ shipped: true, trackingNumbers: '1Z999AA10123456784' })), []);
});

test('fillableGaps: only what the store page has', () => {
  assert.deepEqual(fillableGaps(o({ platform: 'Costco', itemDescription: '', shippingAddress: '' })), ['item']);
  assert.deepEqual(fillableGaps(o({ platform: 'Amazon', shipped: true })), []);
  assert.deepEqual(fillableGaps(o({ platform: 'Lenovo', itemDescription: '' })), []);
});

test('planGapFill: one sync per store, Amazon by order', () => {
  const plan = planGapFill([
    o({ itemDescription: '' }),
    o({ orderNumber: '2', shippingAddress: '' }),
    o({ platform: 'Costco', itemDescription: '' }),
    o({ platform: 'Costco' }),
    o({ platform: 'Amazon', orderNumber: '111-1', itemDescription: null }),
    o({ platform: 'Amazon', orderNumber: '111-1', itemDescription: null }),
    o({ platform: 'Amazon', orderNumber: '111-2' }),
    o({ platform: 'Lenovo', itemDescription: '' }),
  ]);
  assert.deepEqual(plan, { syncs: ['SYNC_WALMART', 'SYNC_COSTCO'], amazonOrders: ['111-1'] });
  assert.deepEqual(planGapFill([o({}), o({ platform: 'Costco', shippingAddress: '' })]), { syncs: [], amazonOrders: [] });
});

test('gapFillLine: counts only', () => {
  const orders = [o({ itemDescription: '', shipped: true })];
  const line = gapFillLine(orders, planGapFill(orders));
  assert.equal(line, '[gap-fill] Walmart.item=1 Walmart.tracking=1 queued=SYNC_WALMART');
  assert.ok(!line.includes('2000000'));
});

test('isUselessDescription', () => {
  assert.ok(isUselessDescription(null));
  assert.ok(isUselessDescription(' Amazon.com '));
  assert.ok(!isUselessDescription('2 items'));
});
