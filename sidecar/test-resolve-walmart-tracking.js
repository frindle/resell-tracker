'use strict';
// resolveWalmartTracking: a Walmart-internal 555 id on the order page means the
// tracking number is the order number (digits only), immediately.
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveWalmartTracking } = require('./src/walmartTracking.js');

const ORDER = '200015366023146';

test('internal id present, nothing scraped -> order number digits, walmart-internal', () => {
  const r = resolveWalmartTracking({ orderNumber: ORDER, scrapedTracking: [], hasInternalTracking: true });
  assert.deepEqual(r, { trackingNumbers: [ORDER], fabricated: true, reason: 'walmart-internal' });
});

test('hyphenated order number is reduced to digits', () => {
  const r = resolveWalmartTracking({ orderNumber: '2000153-66023146', scrapedTracking: [], hasInternalTracking: true });
  assert.deepEqual(r.trackingNumbers, [ORDER]);
  assert.equal(r.reason, 'walmart-internal');
});

test('real carrier number still wins over hasInternalTracking', () => {
  const r = resolveWalmartTracking({ orderNumber: ORDER, scrapedTracking: ['1Z999AA10123456784'], hasInternalTracking: true });
  assert.deepEqual(r, { trackingNumbers: ['1Z999AA10123456784'], fabricated: false, reason: 'carrier' });
});

test('a 555 id in scrapedTracking is never returned', () => {
  const r = resolveWalmartTracking({ orderNumber: ORDER, scrapedTracking: ['55568012507799526245'], hasInternalTracking: true });
  assert.deepEqual(r.trackingNumbers, [ORDER]);
  assert.equal(r.fabricated, true);
  assert.equal(r.reason, 'walmart-internal');
});

test('absent flag keeps the old gate; flag without an order number -> no-order-number', () => {
  const old = resolveWalmartTracking({ orderNumber: ORDER, scrapedTracking: [] });
  assert.deepEqual(old, { trackingNumbers: null, fabricated: false, reason: 'not-store-delivery' });
  const none = resolveWalmartTracking({ orderNumber: '', scrapedTracking: [], hasInternalTracking: true });
  assert.deepEqual(none, { trackingNumbers: null, fabricated: false, reason: 'no-order-number' });
});
