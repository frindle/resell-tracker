/**
 * Tests for the BFMR auto-sync staleness decision.
 *
 *   npm run test:bfmr-auto-sync
 *
 * No test framework is installed in this repo, so these run on Node's built-in
 * runner with type stripping.
 *
 * The bug being guarded against: opening an unlinked order fired a full
 * external BFMR sync on EVERY open (the guard was a per-mount ref). A fresh
 * local dataset must not trigger that; only a stale or missing one may.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldAutoSync, shouldAutoSyncForOrder, parseExpectedItemCount, isFullyAccounted } from './bfmrAutoSync.ts';

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;

test('a linked order never auto-syncs, even if the data is stale', () => {
  assert.equal(shouldAutoSync({ lastSyncMs: NOW - 365 * 24 * 60 * MINUTE, now: NOW, hasLinks: true }), false);
});

test('a linked order never auto-syncs, even if never synced', () => {
  assert.equal(shouldAutoSync({ lastSyncMs: 0, now: NOW, hasLinks: true }), false);
});

test('never synced (lastSyncMs=0) syncs', () => {
  assert.equal(shouldAutoSync({ lastSyncMs: 0, now: NOW, hasLinks: false }), true);
});

test('fresh data (within the default 5-minute threshold) does not sync', () => {
  assert.equal(shouldAutoSync({ lastSyncMs: NOW - MINUTE, now: NOW, hasLinks: false }), false);
});

test('data exactly at the threshold does not sync (strictly greater required)', () => {
  assert.equal(shouldAutoSync({ lastSyncMs: NOW - 5 * MINUTE, now: NOW, hasLinks: false }), false);
});

test('stale data (past the default 5-minute threshold) syncs', () => {
  assert.equal(shouldAutoSync({ lastSyncMs: NOW - 6 * MINUTE, now: NOW, hasLinks: false }), true);
});

test('a custom threshold is honored', () => {
  // 2 minutes old: stale under a 1-minute threshold, fresh under the default.
  assert.equal(shouldAutoSync({ lastSyncMs: NOW - 2 * MINUTE, now: NOW, hasLinks: false, thresholdMs: MINUTE }), true);
  assert.equal(shouldAutoSync({ lastSyncMs: NOW - 2 * MINUTE, now: NOW, hasLinks: false }), false);
});

// --- Accounting gate (Penn's rule) -----------------------------------------
// The pull behind this decision is UNSCOPED — BFMR's /my-tracker API offers
// no order_id filter (TrackerFilter in lib/bfmr.ts), so every pull is the
// full-catalog one. A fully-accounted order must therefore never trigger it,
// and a short one still may.

test('a fully-accounted unlinked order does NOT sync, even when never synced', () => {
  // Expected 3 items from the Amazon scrape; we already hold all 3 locally.
  assert.equal(shouldAutoSyncForOrder({
    lastSyncMs: 0, now: NOW, hasLinks: false, expectedItemCount: 3, accountedQty: 3,
  }), false);
});

test('a fully-accounted unlinked order does NOT sync, even when stale', () => {
  assert.equal(shouldAutoSyncForOrder({
    lastSyncMs: NOW - 365 * 24 * 60 * MINUTE, now: NOW, hasLinks: false, expectedItemCount: 2, accountedQty: 2,
  }), false);
});

test('holding MORE than the expected count is still fully accounted', () => {
  assert.equal(shouldAutoSyncForOrder({
    lastSyncMs: 0, now: NOW, hasLinks: false, expectedItemCount: 1, accountedQty: 2,
  }), false);
});

test('a short order (accounted < expected) DOES sync when never synced', () => {
  assert.equal(shouldAutoSyncForOrder({
    lastSyncMs: 0, now: NOW, hasLinks: false, expectedItemCount: 3, accountedQty: 1,
  }), true);
});

test('a short order (accounted < expected) DOES sync when stale', () => {
  assert.equal(shouldAutoSyncForOrder({
    lastSyncMs: NOW - 6 * MINUTE, now: NOW, hasLinks: false, expectedItemCount: 3, accountedQty: 2,
  }), true);
});

test('a short order with FRESH local data still respects the staleness throttle', () => {
  assert.equal(shouldAutoSyncForOrder({
    lastSyncMs: NOW - MINUTE, now: NOW, hasLinks: false, expectedItemCount: 3, accountedQty: 1,
  }), false);
});

test('an unknown expected count (null) falls back to the plain staleness gate', () => {
  assert.equal(shouldAutoSyncForOrder({ lastSyncMs: 0, now: NOW, hasLinks: false, expectedItemCount: null, accountedQty: 0 }), true);
  assert.equal(shouldAutoSyncForOrder({ lastSyncMs: NOW - MINUTE, now: NOW, hasLinks: false, expectedItemCount: null, accountedQty: 5 }), false);
});

test('a linked order never syncs regardless of accounting', () => {
  assert.equal(shouldAutoSyncForOrder({
    lastSyncMs: 0, now: NOW, hasLinks: true, expectedItemCount: 3, accountedQty: 0,
  }), false);
});

test('isFullyAccounted requires a known positive expected count', () => {
  assert.equal(isFullyAccounted({ expectedItemCount: null, accountedQty: 5 }), false); // unknown -> not "fully"
  assert.equal(isFullyAccounted({ expectedItemCount: 0, accountedQty: 0 }), false);  // degenerate
  assert.equal(isFullyAccounted({ expectedItemCount: 2, accountedQty: 1 }), false);
  assert.equal(isFullyAccounted({ expectedItemCount: 2, accountedQty: 2 }), true);
});

test('parseExpectedItemCount reads the quantity out of scraped descriptions', () => {
  assert.equal(parseExpectedItemCount('3 x Apple Watch Ultra 2'), 3);
  assert.equal(parseExpectedItemCount('1xApple TV 4K'), 1);
  assert.equal(parseExpectedItemCount('Apple Watch Ultra 2, Qty: 2'), 2);
  assert.equal(parseExpectedItemCount('AirPods Pro (quantity 4)'), 4);
  assert.equal(parseExpectedItemCount('Apple Watch Ultra 2 — 3 units'), 3);
});

test('parseExpectedItemCount returns null when no quantity is discernible', () => {
  assert.equal(parseExpectedItemCount('Apple Watch Ultra 2'), null);
  assert.equal(parseExpectedItemCount(''), null);
  assert.equal(parseExpectedItemCount(null), null);
  // "Ultra 2" must not be mistaken for a count of 2.
  assert.equal(parseExpectedItemCount('Apple Watch Ultra 2 (qty unknown)'), null);
});
