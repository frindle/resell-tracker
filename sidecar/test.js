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

console.log('sidecar/test.js: all checks passed');
