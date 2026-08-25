'use strict';

// Minimal smoke test for the since-date arithmetic — the one piece of
// this sidecar's logic that's pure (no DOM/page dependency) and easy to
// silently break (off-by-one on the overlap buffer under/over-scrapes
// or misses orders on every single run). Run with: node test.js
//
// ponytail: not a framework, not exhaustive — just the smallest thing
// that fails if the date math regresses. The DOM-parsing logic (the bulk
// of amazon.js/walmart.js) is ported verbatim from the extension, which
// has its own history of production use; a full browser-driven test of
// that would need a live Amazon/Walmart session, out of scope here.

process.env.TRACKER_URL = process.env.TRACKER_URL || 'http://localhost:9999';
process.env.TRACKER_USER_ID = process.env.TRACKER_USER_ID || '1';

const assert = require('node:assert');
const { computeAmazonSinceDate } = require('./src/amazon');
const { computeWalmartSinceDate } = require('./src/walmart');
const { computeCostcoSinceDate, mapOrder } = require('./src/costco');
const { merchantUrl } = require('./src/cashbackmonitor');

const NOW = new Date('2026-07-30T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

// Amazon: no prior sync → 60-day floor.
{
  const since = computeAmazonSinceDate(null, NOW);
  assert.strictEqual(since.getTime(), NOW.getTime() - 60 * DAY, 'no lastSync should use the 60-day floor');
}

// Amazon: recent lastSync → lastSync minus 1-day overlap buffer.
{
  const lastSync = new Date(NOW.getTime() - 5 * DAY).toISOString();
  const since = computeAmazonSinceDate(lastSync, NOW);
  assert.strictEqual(since.getTime(), new Date(lastSync).getTime() - DAY, 'recent lastSync should get a 1-day overlap buffer, not the 60-day floor');
}

// Amazon: stale lastSync (older than 60 days) → use lastSync as-is (full catch-up, no floor clamp).
{
  const lastSync = new Date(NOW.getTime() - 90 * DAY).toISOString();
  const since = computeAmazonSinceDate(lastSync, NOW);
  assert.strictEqual(since.getTime(), new Date(lastSync).getTime(), 'stale lastSync should scan all the way back to it, unclamped');
}

// Walmart: no prior sync → 30-day floor.
{
  const since = computeWalmartSinceDate(null, NOW);
  assert.strictEqual(since.getTime(), NOW.getTime() - 30 * DAY, 'no lastSync should use the 30-day floor');
}

// Walmart: prior sync → lastSync minus 48h overlap buffer.
{
  const lastSync = new Date(NOW.getTime() - 10 * DAY).toISOString();
  const since = computeWalmartSinceDate(lastSync, NOW);
  assert.strictEqual(since.getTime(), new Date(lastSync).getTime() - 48 * 60 * 60 * 1000, 'lastSync should get a 48h overlap buffer');
}

// Costco: no prior sync → 90-day floor (the extension's own default).
{
  const since = computeCostcoSinceDate(null, NOW);
  assert.strictEqual(since.getTime(), NOW.getTime() - 90 * DAY, 'no lastSync should use the 90-day floor');
}

// Costco: prior sync → lastSync minus a 1-day overlap buffer.
{
  const lastSync = new Date(NOW.getTime() - 7 * DAY).toISOString();
  const since = computeCostcoSinceDate(lastSync, NOW);
  assert.strictEqual(since.getTime(), new Date(lastSync).getTime() - DAY, 'lastSync should get a 1-day overlap buffer');
}

// Costco: an unparseable stored lastSync must fall back to the floor, not
// produce an Invalid Date that silently makes every comparison false.
{
  const since = computeCostcoSinceDate('not-a-date', NOW);
  assert.strictEqual(since.getTime(), NOW.getTime() - 90 * DAY, 'garbage lastSync should fall back to the floor');
}

// Costco order mapping: cancelled orders and cancelled line items drop
// out, and electronic-delivery "tracking" is not real tracking.
{
  assert.strictEqual(mapOrder({ status: 'Cancelled', orderLineItems: [] }), null, 'cancelled orders are skipped');

  const mapped = mapOrder({
    orderNumber: '123456',
    orderPlacedDate: '2026-07-01T10:00:00Z',
    orderTotal: 42.5,
    status: 'Shipped',
    orderLineItems: [
      { itemDescription: 'Widget', status: 'Shipped', shipment: [{ trackingNumber: '1Z999', carrierName: 'UPS' }] },
      { itemDescription: 'Gift Card', status: 'Shipped', shipment: [{ trackingNumber: 'EMAILED', carrierName: 'Email Delivery' }] },
      { itemDescription: 'Dropped', status: 'Canceled', shipment: [{ trackingNumber: '9400111', carrierName: 'USPS' }] },
    ],
  });
  assert.strictEqual(mapped.platform, 'Costco');
  assert.strictEqual(mapped.orderDate, '2026-07-01', 'orderDate is the date half of orderPlacedDate');
  assert.deepStrictEqual(mapped.trackingNumbers, ['1Z999'], 'digital-delivery and cancelled-item tracking must be excluded');
  assert.strictEqual(mapped.itemDescription, 'Widget, Gift Card', 'cancelled line items drop out of the description');
}

// CBM slug construction — the extension built this same URL when opening
// the tab, and a wrong slug silently scrapes a 404 page for zero rates.
{
  assert.strictEqual(
    merchantUrl('Best Buy'),
    'https://www.cashbackmonitor.com/cashback-store/best-buy/?vendor=Best%20Buy',
  );
  assert.strictEqual(
    merchantUrl("Sam's Club"),
    // encodeURIComponent leaves an apostrophe unescaped — same URL the
    // extension produced, which is the bar here.
    "https://www.cashbackmonitor.com/cashback-store/sams-club/?vendor=Sam's%20Club",
  );
}

console.log('sidecar/test.js: all checks passed');
