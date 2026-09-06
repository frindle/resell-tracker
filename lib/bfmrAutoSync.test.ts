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

import { shouldAutoSync } from './bfmrAutoSync.ts';

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
