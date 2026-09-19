// Adversarial repo-style test for: rt-walmart555-tracking-fix   (node --test / tsx --test)
//
// Defect: syncWalmart's per-order fallback (sidecar/src/walmart.js ~line 442-443) only
// substitutes the order number as trackingNumbers when detail.isStoreDelivery is true.
// For a non-store-delivery order where the only "tracking-like" number on the page was
// filtered out upstream as a Walmart-internal 555-prefixed reference (isWalmartInternal),
// detail.tracking.length is 0 AND isStoreDelivery is false, so trackingNumbers is left
// unset entirely (confirmed live: order 930 / Walmart #200015142733782).
//
// Required fix: whenever detail.tracking.length === 0, regardless of isStoreDelivery,
// trackingNumbers must become [order.orderNumber.replace(/[^0-9]/g, '')].
//
// syncWalmart is not a pure function -- it drives a Playwright `page` end to end (goto,
// evaluate, content, url). Rather than mocking a fake DOM, this test drives the REAL
// syncWalmart with a minimal fake `page` whose `.evaluate(fn, ...args)` recognizes the
// in-page helper functions by name (they are not exported, but their function.name is
// stable) and returns controlled data for each -- so the actual host-side loop in
// syncWalmart (the code under test) runs unmodified.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TRACKER_URL = process.env.TRACKER_URL || 'http://localhost:3000';
process.env.TRACKER_USER_ID = process.env.TRACKER_USER_ID || '1';

const { syncWalmart } = require('./sidecar/src/walmart.js');

// One order per test run, scraped on "page 1" with hasOlder:true so syncWalmart's
// list-scrape loop stops after a single page (no pagination/click mocking needed).
function makePage({ orderNumber, orderDateStr, detail }) {
  const scrapedOrder = {
    platform: 'Walmart',
    orderNumber,
    orderDate: orderDateStr,
    itemDescription: 'Test Item',
    cost: 0,
    shippingCost: 0,
    shippingAddress: '',
    trackingNumbers: [],
    sourceUrl: `https://www.walmart.com/orders/${orderNumber}`,
  };
  return {
    url: () => 'https://www.walmart.com/orders',
    content: async () => '<html><body>Orders</body></html>',
    goto: async () => {},
    evaluate: async (fn, ..._args) => {
      const name = fn && fn.name;
      if (name === 'scrapeCurrentPageInBrowser') return { orders: [scrapedOrder], hasOlder: true };
      if (name === 'extractDetailInBrowser') return detail;
      // isLoggedOut's anonymous `() => document.title` probe, and anything else: benign default.
      return '';
    },
  };
}

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

test('order-number fallback fires for a non-store-delivery order with only a filtered 555-internal number (order 930 case)', async () => {
  const orderNumber = '200015142733782';
  const page = makePage({
    orderNumber,
    orderDateStr: todayStr(),
    detail: {
      address: '',
      tracking: [], // the 555-prefixed number was already excluded upstream by isWalmartInternal
      isStoreDelivery: false,
      cost: null,
      itemDescription: '',
      paymentLast4: null,
      deliveryPhotoUrl: null,
      deliveryPhotoBase64: null,
      deliveryPhotoMime: null,
      orderDate: null,
    },
  });
  const result = await syncWalmart(page, { lastSyncIso: null });
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].trackingNumbers, [orderNumber]);
});

test('order-number fallback strips a hyphen from the order number', async () => {
  const rawOrderNumber = '2000-1514273-3782';
  const digitsOnly = '200015142733782';
  const page = makePage({
    orderNumber: rawOrderNumber,
    orderDateStr: todayStr(),
    detail: { address: '', tracking: [], isStoreDelivery: false },
  });
  const result = await syncWalmart(page, { lastSyncIso: null });
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].trackingNumbers, [digitsOnly]);
});

test('store-delivery order with no real tracking still gets the order-number fallback (behavior must be unchanged)', async () => {
  const orderNumber = '200099998888777';
  const page = makePage({
    orderNumber,
    orderDateStr: todayStr(),
    detail: { address: '', tracking: [], isStoreDelivery: true },
  });
  const result = await syncWalmart(page, { lastSyncIso: null });
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].trackingNumbers, [orderNumber]);
});

test('OVER-TRIGGER GUARD: a real carrier tracking number is never overridden by the order-number fallback', async () => {
  const orderNumber = '200011112222333';
  const realTracking = '1Z999AA10123456784';
  const page = makePage({
    orderNumber,
    orderDateStr: todayStr(),
    detail: { address: '', tracking: [realTracking], isStoreDelivery: false },
  });
  const result = await syncWalmart(page, { lastSyncIso: null });
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].trackingNumbers, [realTracking]);
});

test('OVER-TRIGGER GUARD: a store-delivery order WITH real tracking keeps the real tracking, not the order number', async () => {
  const orderNumber = '200044445555666';
  const realTracking = '9400111899223197428490';
  const page = makePage({
    orderNumber,
    orderDateStr: todayStr(),
    detail: { address: '', tracking: [realTracking], isStoreDelivery: true },
  });
  const result = await syncWalmart(page, { lastSyncIso: null });
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].trackingNumbers, [realTracking]);
});

test('detail.tracking containing only the order number itself (filtered out) still triggers the fallback, not an empty array', async () => {
  const orderNumber = '200077778888999';
  const page = makePage({
    orderNumber,
    orderDateStr: todayStr(),
    // A plausible WRONG fix might check "did detail.tracking have entries before filtering"
    // instead of the actual filtered length -- this pins the correct post-filter behavior.
    detail: { address: '', tracking: [orderNumber], isStoreDelivery: false },
  });
  const result = await syncWalmart(page, { lastSyncIso: null });
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].trackingNumbers, [orderNumber]);
});
