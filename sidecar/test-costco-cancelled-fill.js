'use strict';
// SYNC_COSTCO_ORDER: a cancelled order is locked, but the per-order read must
// still reach it (item, card, address). Other locked orders stay skipped.
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

const asked = [];
require('./src/lib').fetchLockedOrderNumbers = async (platform, opts = {}) => {
  asked.push({ platform, opts });
  // 111 is cancelled+locked, 222 is locked and live.
  return new Set(opts.exceptCancelled ? ['222'] : ['111', '222']);
};
const { syncCostcoOrders } = require('./src/costco');

function stopPage() {
  const visited = [];
  return { visited, async goto(u) { visited.push(u); throw new Error('stop-here'); } };
}

test('a cancelled locked order is read; a live locked order is not', async () => {
  asked.length = 0;
  const page = stopPage();
  await assert.rejects(syncCostcoOrders(page, ['111', '222']), /stop-here/);
  assert.equal(page.visited.length, 1, 'the order list was opened, so something was left to read');
  assert.deepEqual(asked, [{ platform: 'costco', opts: { exceptCancelled: true } }]);
});

test('only live locked orders: nothing read', async () => {
  const page = stopPage();
  assert.deepEqual(await syncCostcoOrders(page, ['222']), []);
  assert.equal(page.visited.length, 0);
});
