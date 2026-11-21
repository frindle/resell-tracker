import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderGaps, fillableGaps, planGapFill, gapFillLine, isUselessDescription, isPlaceholderDescription, isReplaceableDescription, type GapOrder } from './gapFill.ts';

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
  // Card only when the caller passed it and it is empty.
  assert.deepEqual(orderGaps(o({ cardId: null })), ['card']);
  assert.deepEqual(orderGaps(o({ cardId: 7 })), []);
});

test('fillableGaps: only what the store page has', () => {
  assert.deepEqual(fillableGaps(o({ platform: 'Costco', itemDescription: '', shippingAddress: '' })), ['item', 'address']);
  // Costco's order email has no address and no card; its order details have both.
  assert.deepEqual(fillableGaps(o({ platform: 'Costco', shippingAddress: null, cardId: null, shipped: true })), ['address', 'tracking', 'card']);
  // Walmart's order page shows the card's last four.
  assert.deepEqual(fillableGaps(o({ platform: 'Walmart', cardId: null })), ['card']);
  assert.deepEqual(fillableGaps(o({ platform: 'Amazon', shipped: true })), []);
  assert.deepEqual(fillableGaps(o({ platform: 'Lenovo', itemDescription: '' })), []);
});

test('planGapFill: Walmart, Costco and Amazon each by order', () => {
  const plan = planGapFill([
    o({ itemDescription: '' }),
    o({ itemDescription: '', cardId: null }),
    o({ orderNumber: '2', shippingAddress: '' }),
    o({ orderNumber: '3' }),
    o({ platform: 'Costco', orderNumber: '1330000001', itemDescription: '' }),
    o({ platform: 'Costco', orderNumber: '1330000001', cardId: null }),
    o({ platform: 'Costco', orderNumber: '1330000002', cardId: null }),
    o({ platform: 'Costco', orderNumber: '1330000003' }),
    o({ platform: 'Amazon', orderNumber: '111-1', itemDescription: null }),
    o({ platform: 'Amazon', orderNumber: '111-1', itemDescription: null }),
    o({ platform: 'Amazon', orderNumber: '111-2' }),
    o({ platform: 'Lenovo', itemDescription: '' }),
  ]);
  assert.deepEqual(plan, { walmartOrders: ['2000000-00000001', '2'], costcoOrders: ['1330000001', '1330000002'], amazonOrders: ['111-1'] });
  assert.deepEqual(planGapFill([o({}), o({ platform: 'Costco', cardId: 3 })]), { walmartOrders: [], costcoOrders: [], amazonOrders: [] });
});

test('gapFillLine: counts only', () => {
  const orders = [o({ itemDescription: '', shipped: true })];
  const line = gapFillLine(orders, planGapFill(orders));
  assert.equal(line, '[gap-fill] Walmart.item=1 Walmart.tracking=1 queued=SYNC_WALMART_ORDER:1');
  assert.ok(!line.includes('2000000'));
  const costco = [o({ platform: 'Costco', orderNumber: '1330000001', shippingAddress: null, cardId: null })];
  const cl = gapFillLine(costco, planGapFill(costco));
  assert.equal(cl, '[gap-fill] Costco.address=1 Costco.card=1 queued=SYNC_COSTCO_ORDER:1');
  assert.ok(!cl.includes('1330000001'));
});

test('isUselessDescription', () => {
  assert.ok(isUselessDescription(null));
  assert.ok(isUselessDescription(' Amazon.com '));
  assert.ok(!isUselessDescription('2 items'));
});

test('group gap: an explicit null buyer is a gap the page can fill; cancelled and locked orders only ever have this one', () => {
  assert.deepEqual(orderGaps(o({ buyerId: null })), ['group']);
  assert.deepEqual(orderGaps(o({})), []);
  assert.deepEqual(orderGaps(o({ buyerId: 3 })), []);
  assert.deepEqual(fillableGaps(o({ platform: 'Amazon', buyerId: null })), ['group']);
  assert.deepEqual(orderGaps(o({ groupOnly: true, itemDescription: '', buyerId: null })), ['group']);
  assert.deepEqual(orderGaps(o({ groupOnly: true, itemDescription: '', buyerId: 3 })), []);
  assert.deepEqual(planGapFill([o({ orderNumber: '7', buyerId: null })]).walmartOrders, ['7']);
});

test('isPlaceholderDescription: email category names only', () => {
  assert.ok(isPlaceholderDescription('Wearable Technology (1 items)'));
  assert.ok(isPlaceholderDescription('Laptops, Electronics (3 items)'));
  assert.ok(!isPlaceholderDescription('Echo Dot (+2 more)'));
  assert.ok(!isPlaceholderDescription('Widget Pro 15.6-inch (2 items)'));
  assert.ok(!isPlaceholderDescription(null));
  assert.ok(isReplaceableDescription('amazon.com') && isReplaceableDescription('Laptops (2 items)'));
  assert.ok(!isReplaceableDescription('Fitness Tracker Band'));
});
