'use strict';
// SYNC_WALMART_ORDER (syncWalmartOrders): the locked-order skip, a page that is
// not the asked-for order, and every page failing. The page is a fake.
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

let lockedNow = new Set();
require('./src/lib').fetchLockedOrderNumbers = async () => lockedNow;
const { syncWalmartOrders, extractDetailInBrowser } = require('./src/walmart');

// A page whose goto lands on `pages[n]` = { url, detail } (or throws when the entry is null,
// leaving the previously loaded page in place).
function fakePage(pages) {
  let cur = { url: 'about:blank', detail: null };
  const visited = [];
  return {
    visited,
    async goto(u) {
      const n = u.split('/orders/')[1];
      visited.push(n);
      if (!pages[n]) throw new Error('timeout');
      cur = pages[n];
    },
    url: () => cur.url,
    content: async () => '<html><title>Order</title></html>',
    evaluate: async () => cur.detail,
  };
}
const good = (n, extra = {}) => ({
  url: `https://www.walmart.com/orders/${n}`,
  detail: { tracking: [], isStoreDelivery: false, isDelivered: false, itemDescription: 'Thing ' + n.slice(-2), address: '1 Test St', cost: 12.5, pageOrderIds: [n], quantity: 2, ...extra },
});

test('locked orders are skipped whether stored with a dash or as digits', async () => {
  lockedNow = new Set(['1000000-00000001', '100000000000002']);
  const page = fakePage({ '100000000000003': good('100000000000003') });
  const rows = await syncWalmartOrders(page, ['100000000000001', '100000000000002', '100000000000003']);
  assert.deepEqual(page.visited, ['100000000000003']);
  assert.deepEqual(rows.map(r => r.orderNumber), ['100000000000003']);
  lockedNow = new Set();
});

test('every locked order: nothing read, no error', async () => {
  lockedNow = new Set(['1000000-00000001']);
  const page = fakePage({});
  assert.deepEqual(await syncWalmartOrders(page, ['100000000000001']), []);
  assert.deepEqual(page.visited, []);
  lockedNow = new Set();
});

test('a timed-out page never files the previous order\'s data under the next order', async () => {
  const page = fakePage({ '100000000000001': good('100000000000001') /* 100000000000002 times out */ });
  const rows = await syncWalmartOrders(page, ['100000000000001', '100000000000002']);
  assert.deepEqual(rows.map(r => r.orderNumber), ['100000000000001']);
});

test('a page that shows a different order is a failure', async () => {
  const page = fakePage({
    '100000000000001': good('100000000000001'),
    '100000000000002': { url: 'https://www.walmart.com/orders/100000000000002', detail: good('100000000000009').detail },
  });
  const rows = await syncWalmartOrders(page, ['100000000000001', '100000000000002']);
  assert.deepEqual(rows.map(r => r.orderNumber), ['100000000000001']);
});

test('a blank or bot-check page returns no row', async () => {
  const blank = { url: 'https://www.walmart.com/orders/100000000000002', detail: { tracking: [], pageOrderIds: [], itemDescription: null, address: '', cost: null } };
  const page = fakePage({ '100000000000001': good('100000000000001'), '100000000000002': blank });
  const rows = await syncWalmartOrders(page, ['100000000000001', '100000000000002']);
  assert.deepEqual(rows.map(r => r.orderNumber), ['100000000000001']);
});

test('a redirect away from the order URL is a failure', async () => {
  const moved = { url: 'https://www.walmart.com/blocked', detail: good('100000000000002').detail };
  const page = fakePage({ '100000000000001': good('100000000000001'), '100000000000002': moved });
  const rows = await syncWalmartOrders(page, ['100000000000001', '100000000000002']);
  assert.equal(rows.length, 1);
});

test('all pages failing throws', async () => {
  const page = fakePage({});
  await assert.rejects(syncWalmartOrders(page, ['100000000000001', '100000000000002']), /none of 2 page\(s\) could be read/);
});

test('more than 25 orders are all read in the one command', async () => {
  const nums = Array.from({ length: 26 }, (_, i) => String(100000000000100 + i));
  const pages = Object.fromEntries(nums.map(n => [n, good(n)]));
  const rows = await syncWalmartOrders(fakePage(pages), nums);
  assert.equal(rows.length, 26);
});

test('quantity counts only items in groups that are not cancelled', async () => {
  const prev = global.document;
  const nd = { props: { pageProps: { initialData: { data: { order: {
    id: '100000000000001',
    groups_1: [
      { status: { statusType: 'DELIVERED' }, items: [{ quantity: 2, productInfo: { name: 'Thing' } }] },
      { status: { statusType: 'CANCELED' }, items: [{ quantity: 5 }] },
    ],
  } } } } } };
  const html = '<html></html>';
  global.document = {
    documentElement: { outerHTML: html },
    querySelector: sel => (sel === '#__NEXT_DATA__' ? { textContent: JSON.stringify(nd) } : null),
    querySelectorAll: () => [],
  };
  try {
    const d = await extractDetailInBrowser();
    assert.equal(d.quantity, 2);
    assert.deepEqual(d.pageOrderIds, ['100000000000001']);
  } finally { global.document = prev; }
});
