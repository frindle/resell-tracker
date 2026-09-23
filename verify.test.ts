// Adversarial repo-style test for: rt-walmart-store-tracking-gate   (node --test / tsx --test)
//
// The target is a dependency-free CommonJS decision module (no HTTP handler),
// so the adversarial cases drive the real exported function with inputs that
// separate "did the job" from "made the test go green": each hard property in
// TASK.md gets at least one case, including the exact regression (a plausible
// wrong build returns the order number where null is required) and the
// over-trigger guards (carrier tracking must win even when every flag says
// fabricate; placeholders/internal ids must never be returned as 'carrier').
import { test } from 'node:test';
import assert from 'node:assert/strict';

import walmartTracking from './sidecar/src/walmartTracking.js';

const { resolveWalmartTracking, isFabricatedOrderNumberTracking, WALMART_INTERNAL_TRACKING_RE } = walmartTracking;

// --- the exact regression (commit 82b8fc1) ---------------------------------
test('a not-yet-shipped non-store order with zero scraped tracking returns null, NOT a fabricated value', () => {
  const r = resolveWalmartTracking({
    orderNumber: '5034976218',
    scrapedTracking: [],
    isStoreDelivery: false,
    isDelivered: false,
  });
  assert.equal(r.trackingNumbers, null);
  assert.equal(r.fabricated, false);
  assert.equal(r.reason, 'not-store-delivery');
});

test('a store-delivery order that is not yet delivered returns null, NOT a fabricated value', () => {
  const r = resolveWalmartTracking({
    orderNumber: '5034976218',
    scrapedTracking: [],
    isStoreDelivery: true,
    isDelivered: false,
  });
  assert.equal(r.trackingNumbers, null);
  assert.equal(r.fabricated, false);
  assert.equal(r.reason, 'store-delivery-pending');
});

// --- only the delivered store delivery gets the placeholder -----------------
test('a DELIVERED store delivery with no scraped tracking gets the digits-only order number, flagged fabricated', () => {
  const r = resolveWalmartTracking({
    orderNumber: '5034976218',
    scrapedTracking: [],
    isStoreDelivery: true,
    isDelivered: true,
  });
  assert.deepEqual(r.trackingNumbers, ['5034976218']);
  assert.equal(r.fabricated, true);
  assert.equal(r.reason, 'store-delivery-final');
});

test('the placeholder keeps the digits-only format even when the order number carries dashes', () => {
  const r = resolveWalmartTracking({
    orderNumber: '5034-9762-18',
    scrapedTracking: undefined,
    isStoreDelivery: true,
    isDelivered: true,
  });
  assert.deepEqual(r.trackingNumbers, ['5034976218']);
  assert.equal(r.fabricated, true);
});

// --- real carrier tracking ALWAYS wins --------------------------------------
test('carrier tracking wins even with isStoreDelivery and isDelivered both true', () => {
  const r = resolveWalmartTracking({
    orderNumber: '5034976218',
    scrapedTracking: ['1Z999AA10123456784'],
    isStoreDelivery: true,
    isDelivered: true,
  });
  assert.deepEqual(r.trackingNumbers, ['1Z999AA10123456784']);
  assert.equal(r.fabricated, false);
  assert.equal(r.reason, 'carrier');
});

test('a surviving TBA/9xx value is returned as carrier even on a pending non-store order', () => {
  const r = resolveWalmartTracking({
    orderNumber: '5034976218',
    scrapedTracking: ['TBA123456789US'],
    isStoreDelivery: false,
    isDelivered: false,
  });
  assert.deepEqual(r.trackingNumbers, ['TBA123456789US']);
  assert.equal(r.fabricated, false);
  assert.equal(r.reason, 'carrier');
});

// --- over-trigger guards: placeholders and internal ids are never 'carrier' --
test('a scraped value equal to the order number (with dashes) is filtered out, leaving null', () => {
  const r = resolveWalmartTracking({
    orderNumber: '5034976218',
    scrapedTracking: ['5034-9762-18'],
    isStoreDelivery: false,
    isDelivered: false,
  });
  assert.equal(r.trackingNumbers, null);
  assert.equal(r.fabricated, false);
  assert.notEqual(r.reason, 'carrier');
});

test('a scraped value equal to the order number (digits only) is filtered out even on a delivered store delivery', () => {
  const r = resolveWalmartTracking({
    orderNumber: '5034976218',
    scrapedTracking: ['5034976218'],
    isStoreDelivery: true,
    isDelivered: true,
  });
  assert.deepEqual(r.trackingNumbers, ['5034976218']);
  assert.equal(r.fabricated, true); // fell through to the placeholder path, not 'carrier'
  assert.equal(r.reason, 'store-delivery-final');
});

test('a 555-prefixed Walmart-internal value is filtered out and leaves null rather than a fake carrier number', () => {
  const internal = '555123456789012345'; // matches /^555\d{15,}$/ (555 + 15 digits)
  assert.ok(WALMART_INTERNAL_TRACKING_RE.test(internal), 'fixture sanity: id must match the internal pattern');
  const r = resolveWalmartTracking({
    orderNumber: '5034976218',
    scrapedTracking: [internal],
    isStoreDelivery: false,
    isDelivered: false,
  });
  assert.equal(r.trackingNumbers, null);
  assert.equal(r.fabricated, false);
  assert.notEqual(r.reason, 'carrier');
});

test('a mix of junk and one real carrier number returns only the survivor', () => {
  const r = resolveWalmartTracking({
    orderNumber: '5034976218',
    scrapedTracking: ['', '   ', '5034-9762-18', '555123456789012345', '9405500000000000000000'],
    isStoreDelivery: true,
    isDelivered: false,
  });
  assert.deepEqual(r.trackingNumbers, ['9405500000000000000000']);
  assert.equal(r.fabricated, false);
  assert.equal(r.reason, 'carrier');
});

test('a whitespace-only order number counts as missing: no-order-number, not a flag-based reason', () => {
  const r = resolveWalmartTracking({
    orderNumber: '   ',
    scrapedTracking: [],
    isStoreDelivery: false,
    isDelivered: false,
  });
  assert.equal(r.trackingNumbers, null);
  assert.equal(r.fabricated, false);
  assert.equal(r.reason, 'no-order-number');
});

test('a single-digit scraped value equal to the order number is a placeholder and must be filtered out', () => {
  const r = resolveWalmartTracking({
    orderNumber: '5',
    scrapedTracking: ['5'],
    isStoreDelivery: false,
    isDelivered: false,
  });
  assert.equal(r.trackingNumbers, null);
  assert.equal(r.fabricated, false);
  assert.notEqual(r.reason, 'carrier');
});

test('a non-numeric scraped value is real carrier tracking even when the order number is all digits', () => {
  const r = resolveWalmartTracking({
    orderNumber: '5034976218',
    scrapedTracking: ['ABC'],
    isStoreDelivery: false,
    isDelivered: false,
  });
  assert.deepEqual(r.trackingNumbers, ['ABC']);
  assert.equal(r.fabricated, false);
  assert.equal(r.reason, 'carrier');
});

// --- degenerate inputs must not throw ---------------------------------------
test('missing order number with no scraped tracking is no-order-number', () => {
  const r = resolveWalmartTracking({
    orderNumber: '',
    scrapedTracking: [],
    isStoreDelivery: true,
    isDelivered: true,
  });
  assert.equal(r.trackingNumbers, null);
  assert.equal(r.fabricated, false);
  assert.equal(r.reason, 'no-order-number');
});

test('undefined flags and undefined scrapedTracking do not throw', () => {
  const r = resolveWalmartTracking({ orderNumber: '5034976218' });
  assert.equal(r.trackingNumbers, null);
  assert.equal(r.fabricated, false);
  assert.equal(r.reason, 'not-store-delivery');
});

// --- isFabricatedOrderNumberTracking ----------------------------------------
test('isFabricatedOrderNumberTracking compares digits-only and requires both non-empty', () => {
  assert.equal(isFabricatedOrderNumberTracking('5034-9762-18', '5034976218'), true);
  assert.equal(isFabricatedOrderNumberTracking('5034976218', '5034976218'), true);
  assert.equal(isFabricatedOrderNumberTracking('', '5034976218'), false);
  assert.equal(isFabricatedOrderNumberTracking('5034976218', ''), false);
  assert.equal(isFabricatedOrderNumberTracking(undefined, '5034976218'), false);
  assert.equal(isFabricatedOrderNumberTracking('1Z999AA10123456784', '5034976218'), false);
});

test('isFabricatedOrderNumberTracking reduces BOTH sides to digits (mixed dash formats still match)', () => {
  // value is digits-only, order number carries dashes -- both must be reduced before comparing.
  assert.equal(isFabricatedOrderNumberTracking('5034976218', '5034-9762-18'), true);
  assert.equal(isFabricatedOrderNumberTracking('5034-9762-18', '5034-9762-18'), true);
});

test('isFabricatedOrderNumberTracking is false when the value has no digits at all (even if non-empty)', () => {
  // Both args non-empty, but only one side carries digits -- a digit-free value can never equal a digit-bearing order number.
  assert.equal(isFabricatedOrderNumberTracking('ABC', '5034976218'), false);
  // Both sides digit-free: the empty digit form must NOT count as a match (length guard).
  assert.equal(isFabricatedOrderNumberTracking('XYZ', 'ABC'), false);
});

test('isFabricatedOrderNumberTracking matches a single-digit value against the same single digit', () => {
  assert.equal(isFabricatedOrderNumberTracking('5', '5'), true);
  assert.equal(isFabricatedOrderNumberTracking('5', '5034976218'), false);
});

test('isFabricatedOrderNumberTracking requires BOTH args truthy (a falsy value is never a placeholder)', () => {
  // A falsy value (e.g. numeric 0) must be rejected even when the order number is non-empty and its digits match.
  assert.equal(isFabricatedOrderNumberTracking(0, '0'), false);
  assert.equal(isFabricatedOrderNumberTracking(null, '5034976218'), false);
});

// --- fabricated flag is true on exactly one path -----------------------------
test('fabricated is false on every non-final path and true only for store-delivery-final', () => {
  const base = { orderNumber: '5034976218' };
  assert.equal(resolveWalmartTracking({ ...base, scrapedTracking: ['1Z999AA10123456784'], isStoreDelivery: true, isDelivered: true }).fabricated, false); // carrier
  assert.equal(resolveWalmartTracking({ orderNumber: '', scrapedTracking: [], isStoreDelivery: true, isDelivered: true }).fabricated, false); // no-order-number
  assert.equal(resolveWalmartTracking({ ...base, scrapedTracking: [], isStoreDelivery: false, isDelivered: true }).fabricated, false); // not-store-delivery
  assert.equal(resolveWalmartTracking({ ...base, scrapedTracking: [], isStoreDelivery: true, isDelivered: false }).fabricated, false); // store-delivery-pending
  assert.equal(resolveWalmartTracking({ ...base, scrapedTracking: [], isStoreDelivery: true, isDelivered: true }).fabricated, true); // store-delivery-final
});
