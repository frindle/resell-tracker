'use strict';
// SYNC_COSTCO_ORDER with subtotalOnly (lib/costcoSubtotalFill.ts): locked
// orders are read too, and only the merchandise subtotal goes back.
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

let asked = 0;
require('./src/lib').fetchLockedOrderNumbers = async () => { asked++; return new Set(['222']); };
const { syncCostcoOrders, subtotalRows } = require('./src/costco');

function stopPage() {
  const visited = [];
  return { visited, async goto(u) { visited.push(u); throw new Error('stop-here'); } };
}

test('subtotalOnly: a locked order is read and the lock list is not asked for', async () => {
  asked = 0;
  const page = stopPage();
  await assert.rejects(syncCostcoOrders(page, ['222'], { subtotalOnly: true }), /stop-here/);
  assert.equal(page.visited.length, 1);
  assert.equal(asked, 0);
});

test('without subtotalOnly the same locked order is still skipped', async () => {
  const page = stopPage();
  assert.deepEqual(await syncCostcoOrders(page, ['222']), []);
  assert.equal(page.visited.length, 0);
});

test('subtotal rows carry only the subtotal, the date the import needs, and the flags', () => {
  const full = {
    platform: 'Costco', orderNumber: '111', orderDate: '2026-11-01', itemDescription: 'x', cost: 107.5, shippingCost: 0,
    shippingAddress: 'a', trackingNumbers: ['1Z'], paymentLast4: '1234', merchandiseSubtotal: 99.99,
  };
  assert.deepEqual(subtotalRows([full, { ...full, orderNumber: '222', merchandiseSubtotal: undefined }]), [
    { platform: 'Costco', orderNumber: '111', orderDate: '2026-11-01', merchandiseSubtotal: 99.99, subtotalOnly: true, updateOnly: true },
  ]);
});
