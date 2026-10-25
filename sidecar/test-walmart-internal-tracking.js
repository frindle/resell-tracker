'use strict';
// syncWalmart must tell resolveWalmartTracking whether the order page carried a
// Walmart-internal 555 id ("Deliver via Walmart"), via hasInternalTracking.
// resolveWalmartTracking is replaced by a spy so this test covers only the
// scraper side (walmart.js), not the resolver.
process.env.TRACKER_URL = process.env.TRACKER_URL || 'http://localhost:9';
process.env.TRACKER_USER_ID = process.env.TRACKER_USER_ID || '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const calls = [];
const resolverPath = require.resolve('./src/walmartTracking.js');
require.cache[resolverPath] = {
  id: resolverPath, filename: resolverPath, loaded: true,
  exports: {
    resolveWalmartTracking: (opts) => { calls.push(opts); return { trackingNumbers: ['SPY'], fabricated: false, reason: 'carrier' }; },
  },
};
const { syncWalmart } = require('./src/walmart.js');

const ORDER = '200015366023146';

function fakePage(detailHtml) {
  return {
    url: () => 'https://www.walmart.com/orders',
    content: async () => '<html><title>Orders</title></html>',
    goto: async () => {},
    evaluate: async (fn) => {
      switch (fn.name) {
        case 'scrapeCurrentPageInBrowser':
          return {
            hasOlder: true,
            orders: [{
              orderNumber: ORDER, sourceUrl: 'https://www.walmart.com/orders/' + ORDER,
              orderDate: '2099-01-01', cost: 10, itemDescription: 'Kindle', trackingNumbers: [],
            }],
          };
        case 'ordersLoadedInBrowser': return true;
        case 'getFirstBlockFingerprintInBrowser': return 'fp';
        case 'extractDetailInBrowser': {
          const prev = globalThis.document;
          globalThis.document = {
            title: 'Order',
            documentElement: { outerHTML: detailHtml },
            querySelector: () => null,
            querySelectorAll: () => [],
          };
          try { return await fn(); } finally { globalThis.document = prev; }
        }
        default: return '';
      }
    },
  };
}

async function optsFor(detailHtml) {
  calls.length = 0;
  const orders = await syncWalmart(fakePage(detailHtml), { lastSyncIso: null });
  assert.equal(orders.length, 1);
  assert.equal(calls.length, 1);
  return calls[0];
}

test('555 id on the order page -> hasInternalTracking true, the 555 id is not passed as tracking', async () => {
  const o = await optsFor('<html><body>Just shipped Deliver via Walmart {"trackingNumber":"55568012507799526245"}</body></html>');
  assert.equal(o.hasInternalTracking, true);
  assert.deepEqual(o.scrapedTracking, []);
  assert.equal(o.orderNumber, ORDER);
});

test('555 id plus a real UPS number -> hasInternalTracking true and the UPS number passed', async () => {
  const o = await optsFor('<html><body>{"trackingNumber":"55568012507799526245"} 1Z999AA10123456784</body></html>');
  assert.equal(o.hasInternalTracking, true);
  assert.deepEqual(o.scrapedTracking, ['1Z999AA10123456784']);
});

test('no 555 id -> hasInternalTracking is false', async () => {
  const o = await optsFor('<html><body>Just shipped 1Z999AA10123456784</body></html>');
  assert.equal(o.hasInternalTracking, false);
  assert.deepEqual(o.scrapedTracking, ['1Z999AA10123456784']);
});
