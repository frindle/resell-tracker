'use strict';
// Walmart's list JSON (PurchaseHistoryV3 in __NEXT_DATA__) gives order dates,
// canceled/pickup status, item, total and card last-4; the merge lets that JSON
// drive the page while keeping cards the JSON does not cover.
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.TRACKER_URL = process.env.TRACKER_URL || 'http://127.0.0.1:9';
process.env.TRACKER_USER_ID = process.env.TRACKER_USER_ID || '1';
try { require.resolve('playwright-core'); } catch (_) {
  const Module = require('module');
  const origLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'playwright-core') return { chromium: {} };
    return origLoad.call(this, request, ...rest);
  };
}

const { walmartOrdersFromPurchaseHistory, mergeWalmartPage } = require('./src/walmart');

// Walmart PurchaseHistory JSON (shape from __NEXT_DATA__ / PurchaseHistoryV3), fake numbers.
const order = (id, date, statuses, extra = {}) => ({
  id, displayId: id.slice(0, 7) + '-' + id.slice(7), orderDate: date, isInStore: false, type: 'GLASS',
  groups: statuses.map(st => ({ status: { statusType: st }, fulfillmentType: 'DELIVERY', items: [{ name: 'Thing ' + id.slice(-2), quantity: 1 }] })),
  priceDetails: { orderTotal: { displayValue: '$10.00', value: 123.45 } },
  paymentMethods: [{ cardType: 'AMEX', description: 'Ending in 2468', paymentType: 'CREDITCARD' }],
  ...extra,
});

test('Walmart JSON: local order date, canceled/pickup flags, item, total, last-4', () => {
  const meta = walmartOrdersFromPurchaseHistory({ orders: [
    order('100000000000001', '2026-11-13T11:11:09-07:00', ['PLACED']),
    order('100000000000002', '2026-11-12T23:30:00-05:00', ['CANCELED']),
    order('100000000000003', '2026-11-10T09:00:00-05:00', ['DELIVERED', 'CANCELED']),
    order('100000000000004', '2026-11-09T09:00:00-05:00', ['DELIVERED'], { isInStore: true }),
    { id: '', orderDate: 'x' }, null,
  ] });
  assert.equal(meta.length, 4);
  assert.deepEqual(meta[0], { orderNumber: '100000000000001', orderDate: '2026-11-13', canceled: false, pickup: false,
    itemDescription: 'Thing 01', cost: 123.45, paymentLast4: '2468' });
  assert.equal(meta[1].canceled, true);
  assert.equal(meta[2].canceled, false, 'partly canceled order is kept');
  assert.equal(meta[3].pickup, true);
  assert.deepEqual(walmartOrdersFromPurchaseHistory(null), []);
});

test('Walmart merge: JSON drives date/skip/stop; uncovered cards kept; no JSON keeps the card scrape', () => {
  const meta = walmartOrdersFromPurchaseHistory({ orders: [
    order('100000000000001', '2026-11-13T11:11:09-07:00', ['PLACED']),
    order('100000000000002', '2026-11-12T23:30:00-05:00', ['CANCELED']),
    order('100000000000005', '2026-10-01T10:00:00-04:00', ['DELIVERED']),
  ] });
  const dom = { hasOlder: false, blockCount: 4, orders: [
    { orderNumber: '100000000000001', orderDate: '', itemDescription: 'Card title', cost: 0 },
    { orderNumber: '100000000000009', orderDate: '', itemDescription: 'Only on the card', cost: 5 },
  ] };
  const { orders, hasOlder } = mergeWalmartPage(meta, dom, '2026-11-01');
  assert.deepEqual(orders.map(o => o.orderNumber), ['100000000000001', '100000000000009']);
  assert.equal(orders[0].orderDate, '2026-11-13');
  assert.equal(orders[0].cost, 123.45);
  assert.equal(orders[0].paymentLast4, '2468');
  assert.equal(hasOlder, false, 'one older order on a page that also has in-window orders keeps paging');
  const allOld = walmartOrdersFromPurchaseHistory({ orders: [order('100000000000005', '2026-10-01T10:00:00-04:00', ['DELIVERED'])] });
  assert.equal(mergeWalmartPage(allOld, { orders: [], hasOlder: false }, '2026-11-01').hasOlder, true);
  assert.deepEqual(mergeWalmartPage([], dom, '2026-11-01'), { orders: dom.orders, hasOlder: false });
});

// SYNC_WALMART_ORDER: one row from an order page's detail read.
test('Walmart order page: row carries item, qty, address, card and tracking', () => {
  const { walmartRowFromDetail } = require('./src/walmart');
  const row = walmartRowFromDetail('100000000000001', {
    address: 'Test Person, 1 Test St, Springfield, ZZ 00001', tracking: ['1Z999AA10123456784', '100000000000001'],
    isStoreDelivery: false, isDelivered: false, hasInternalTracking: false,
    orderDate: '2026-11-13T11:11:09-07:00', cost: 55.5, taxAmount: 3, itemDescription: 'Thing 01',
    paymentLast4: '2468', quantity: 3,
  });
  assert.equal(row.orderNumber, '100000000000001');
  assert.equal(row.platform, 'Walmart');
  assert.equal(row.orderDate, '2026-11-13');
  assert.equal(row.itemDescription, 'Thing 01');
  assert.equal(row.shippingAddress, 'Test Person, 1 Test St, Springfield, ZZ 00001');
  assert.deepEqual(row.trackingNumbers, ['1Z999AA10123456784']);
  assert.equal(row.paymentLast4, '2468');
  assert.equal(row.quantity, 3);
  assert.equal(row.sourceUrl, 'https://www.walmart.com/orders/100000000000001');
  const bare = walmartRowFromDetail('100000000000002', { tracking: [] });
  assert.equal(bare.paymentLast4, undefined);
  assert.equal(bare.quantity, undefined);
  assert.equal(bare.shippingAddress, '');
});
