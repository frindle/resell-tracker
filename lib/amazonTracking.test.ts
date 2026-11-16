import test from 'node:test';
import assert from 'node:assert/strict';
import {
  trackingUserId, pickTrackingTarget, parseTrackPayload, ordersToQueue, mergeTrackPayload, trackFailedText, SIDECAR_BLOCK_SKIP_MS,
} from './amazonTracking.ts';

const A = '111-0000000-0000001';
const B = '112-0000000-0000002';
const C = '113-0000000-0000003';
const NOW = Date.parse('2026-11-15T20:00:00Z');

test('tracking user comes from the sidecar user id, default 1', () => {
  assert.equal(trackingUserId({}), 1);
  assert.equal(trackingUserId({ TRACKER_USER_ID: '2' }), 2);
  assert.equal(trackingUserId({ SIDECAR_TRACKER_USER_ID: '3' }), 3);
  assert.equal(trackingUserId({ TRACKER_USER_ID: 'x' }), 1);
});

test('the sidecar goes first unless it was blocked in the last day', () => {
  assert.equal(pickTrackingTarget('active', null, NOW), 'sidecar');
  assert.equal(pickTrackingTarget('expired', new Date(NOW).toISOString(), NOW), 'sidecar');
  assert.equal(pickTrackingTarget('blocked', new Date(NOW - 60_000).toISOString(), NOW), 'chrome');
  assert.equal(pickTrackingTarget('blocked', new Date(NOW - SIDECAR_BLOCK_SKIP_MS - 1).toISOString(), NOW), 'sidecar');
  assert.equal(pickTrackingTarget('blocked', 'garbage', NOW), 'sidecar');
  assert.equal(pickTrackingTarget(null, null, NOW), 'sidecar');
});

test('payloads parse, bad ones are null', () => {
  assert.deepEqual(parseTrackPayload(JSON.stringify({ orderNumbers: [A], userId: '1' })), { orderNumbers: [A], userId: 1 });
  assert.equal(parseTrackPayload('{'), null);
  assert.equal(parseTrackPayload(JSON.stringify({ userId: 1 })), null);
  assert.equal(parseTrackPayload(null), null);
});

test('orders already queued, duplicates and non-Amazon numbers are skipped', () => {
  const inFlight = [{ orderNumbers: [A], userId: 1 }, null];
  assert.deepEqual(ordersToQueue([A, B, ` ${C} `, B, '12345', '1110000000000001'], inFlight), [B, C]);
  assert.deepEqual(ordersToQueue([A.replace(/-/g, '')], inFlight), []);
});

test('a pending command gains new orders without repeats', () => {
  const merged = mergeTrackPayload({ orderNumbers: [A], userId: 1, from: 'sidecar' }, { orderNumbers: [A, B], userId: 1 });
  assert.deepEqual(merged, { orderNumbers: [A, B], userId: 1, from: 'sidecar' });
  assert.deepEqual(mergeTrackPayload(null, { orderNumbers: [C], userId: 1 }), { orderNumbers: [C], userId: 1 });
});

test('failure text has no order numbers and says what to do', () => {
  const blocked = trackFailedText({ orderNumbers: [A, B], userId: 1 }, { blocked: true });
  assert.match(blocked, /^2 Amazon orders still need tracking\. Brave stopped/);
  assert.ok(!blocked.includes(A));
  assert.match(trackFailedText({ orderNumbers: [A], userId: 1 }, { error: 'tab closed' }), /^1 Amazon order still .*\(tab closed\)/);
  assert.match(trackFailedText(null, null), /^Some Amazon orders/);
});
