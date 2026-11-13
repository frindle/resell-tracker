'use strict';
// Amazon's Nov 2026 order page shows the card as a react-native-web
// [aria-label="payment method"] entry ("Prime Store Card •••• 4321" + "Earns 5%
// back and extra 1% on items using Amazon Day delivery."). The import matches
// same-last-4 Store Card entries by rate, so the parsers must give last-4,
// brand and the 6% total. Walmart's list JSON gives dates, status and last-4.
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

const { extractCardFromPaymentHtml, paymentRateFromHtml } = require('./src/amazon');
const { walmartOrdersFromPurchaseHistory, mergeWalmartPage } = require('./src/walmart');

const ENTRY = (msg, detail) => '<div class="css-g5y9jx"><div aria-label="payment method" class="css-g5y9jx">' +
  '<div class="css-g5y9jx" style="display:flex;flex:1" data-testid="payment-instrument">' +
  '<div role="presentation" data-testid="payment-instrument-art"><img alt="" src="https://m.media-amazon.com/x.png"></div>' +
  '<div class="css-g5y9jx" style="flex:1;margin-left:12px"><div dir="auto" data-testid="payment-instrument-text-wrapper">' +
  '<span class="css-1jxf684" style="font-size:14px" data-testid="payment-instrument-message">' + msg + '</span></div>' +
  (detail ? '<div role="alert" style="width:100%" data-testid="payment-instrument-feature-detail"><div dir="auto" data-testid="paragraph">' +
    '<span style="width:100%" data-testid="paragraph-fragment-0">' + detail + '</span><span data-testid="paragraph-fragment-1"> </span>' +
    '<a href="#" role="link" data-testid="link"><span>See terms and conditions</span></a></div></div>' : '') +
  '</div></div></div></div>';

const STORE_CARD = ENTRY('Prime Store Card •••• 4321', 'Earns 5% back and extra 1% on items using Amazon Day delivery.');

test('Store Card entry: last-4, brand from the last-4 leaf, 5% + extra 1% = 6%', () => {
  assert.deepEqual(extractCardFromPaymentHtml(STORE_CARD), { last4: '4321', brand: 'Prime Store Card' });
  assert.equal(paymentRateFromHtml(STORE_CARD), 6);
});

test('base rate only, and no rate text -> null rate', () => {
  assert.equal(paymentRateFromHtml(ENTRY('Prime Store Card •••• 4321', 'Earns 5% back.')), 5);
  assert.equal(paymentRateFromHtml(ENTRY('Visa •••• 9876')), null);
  assert.equal(paymentRateFromHtml(''), null);
  assert.equal(paymentRateFromHtml(null), null);
});

test('split payment: a gift-card line without digits first, the card entry second', () => {
  const html = '<div aria-label="payment method list">' + ENTRY('Amazon gift card balance') + STORE_CARD + '</div>';
  assert.deepEqual(extractCardFromPaymentHtml(html), { last4: '4321', brand: 'Prime Store Card' });
  assert.equal(paymentRateFromHtml(html), 6);
});

test('brand and digits in separate leaves still gives the brand; old markup still parses', () => {
  const split = '<div aria-label="payment method"><span>Visa</span><span>•••• 9876</span></div>';
  assert.deepEqual(extractCardFromPaymentHtml(split), { last4: '9876', brand: 'Visa' });
  const legacy = "<ul aria-label='payment method list'><li aria-label='payment method'><span>Mastercard ending in 1111</span></li></ul>";
  assert.deepEqual(extractCardFromPaymentHtml(legacy), { last4: '1111', brand: 'Mastercard' });
  assert.equal(extractCardFromPaymentHtml('<div>Prime Store Card •••• 4321</div>'), null);
  assert.equal(extractCardFromPaymentHtml(42), null);
});

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
