/**
 * Regression tests for how far back a sync looks.
 *
 *   npm run test:sync-window
 *
 * No test framework is installed in this repo, so these run on Node's built-in
 * runner with type stripping. The subject is sidecar/src/syncWindow.js, which
 * is deliberately dependency-free so it can be required from here — the rest
 * of the sidecar pulls in playwright and a TRACKER_URL env var.
 *
 * The bug: `amazon_sidecar_last_sync` is stamped with today's date after every
 * successful run, so an incremental window of "last sync minus one day" was
 * about 48 hours wide, measured by ORDER PLACED date. An order placed a week
 * ago that ships tonight was outside that window on every sync in between, so
 * its tracking number was never picked up — while orders that shipped the day
 * after they were placed came through fine.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import syncWindow from '../sidecar/src/syncWindow.js';

const { computeSinceDate, computeAmazonSinceDate, lookbackDaysFromEnv, AMAZON_COLD_START_DAYS } = syncWindow;

const NOW = new Date('2026-08-27T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const daysBack = (d: Date) => Math.round((NOW.getTime() - d.getTime()) / DAY);

// --- the reported bug -----------------------------------------------------
test('an order placed a week ago is still in the window after last night’s sync', () => {
  // The exact situation: synced yesterday, so the watermark says yesterday.
  // An order placed on the 20th picked up a tracking number overnight.
  const since = computeAmazonSinceDate('2026-08-26', NOW);
  const placed = new Date('2026-08-20T00:00:00.000Z');
  assert.ok(since <= placed, `window starts ${since.toISOString()}, which is after the order was placed`);
});

test('the incremental window is days wide, not hours', () => {
  // Before the floor this returned two days. Two days is not long enough for
  // an order to be placed, ship, and have the tracking number appear.
  assert.equal(daysBack(computeAmazonSinceDate('2026-08-26', NOW)), 14);
  assert.equal(daysBack(computeAmazonSinceDate('2026-08-27', NOW)), 14);
});

test('same-day repeat syncs do not narrow the window each time', () => {
  // The watermark is a date, so a second sync on the same day rewrites it to
  // the same value. The window must not creep shut.
  const first = computeAmazonSinceDate('2026-08-26', NOW);
  const second = computeAmazonSinceDate('2026-08-27', NOW);
  assert.equal(second.getTime(), first.getTime());
});

// --- the cases the floor must not break -----------------------------------
test('a first-ever sync still reaches back the full cold-start window', () => {
  assert.equal(daysBack(computeAmazonSinceDate(null, NOW)), AMAZON_COLD_START_DAYS);
  assert.equal(daysBack(computeAmazonSinceDate('', NOW)), AMAZON_COLD_START_DAYS);
  assert.equal(daysBack(computeAmazonSinceDate(undefined, NOW)), AMAZON_COLD_START_DAYS);
});

test('an unparseable watermark is treated as no watermark, not as an empty window', () => {
  // A NaN date would compare as "not older" on every order and scrape nothing.
  const since = computeAmazonSinceDate('not a date', NOW);
  assert.ok(!isNaN(since.getTime()));
  assert.equal(daysBack(since), AMAZON_COLD_START_DAYS);
});

test('a sidecar that has been off for months keeps its own older watermark', () => {
  // The floor must pull the window BACK, never forward — otherwise a long
  // outage would silently skip everything between the watermark and the floor.
  const since = computeAmazonSinceDate('2026-05-01', NOW);
  assert.equal(since.toISOString().slice(0, 10), '2026-04-30');
  assert.ok(daysBack(since) > AMAZON_COLD_START_DAYS);
});

test('a watermark far in the past is not clamped to the cold-start window either', () => {
  const since = computeAmazonSinceDate('2025-01-01', NOW);
  assert.equal(since.toISOString().slice(0, 10), '2024-12-31');
});

// --- the generic window ---------------------------------------------------
test('the floor is whichever reaches further back', () => {
  const opts = { coldStartDays: 60, minLookbackDays: 14, now: NOW };
  assert.equal(daysBack(computeSinceDate({ ...opts, lastSyncIso: '2026-08-26' })), 14);   // floor wins
  // 2026-08-01 minus a day's overlap is 2026-07-31, which is further back
  // than the 14-day floor, so the watermark is what survives.
  assert.equal(
    computeSinceDate({ ...opts, lastSyncIso: '2026-08-01' }).toISOString(),
    '2026-07-31T00:00:00.000Z',
  );
});

test('a zero-day floor reproduces the old behaviour exactly', () => {
  // Kept honest: with no floor this is the two-day window that caused the bug.
  const since = computeSinceDate({ lastSyncIso: '2026-08-26', coldStartDays: 60, minLookbackDays: 0, now: NOW });
  assert.equal(since.toISOString(), '2026-08-25T00:00:00.000Z');
});

test('the overlap subtracted from the watermark is configurable', () => {
  const since = computeSinceDate({
    lastSyncIso: '2026-08-26', coldStartDays: 60, minLookbackDays: 0, overlapMs: 48 * 60 * 60 * 1000, now: NOW,
  });
  assert.equal(since.toISOString(), '2026-08-24T00:00:00.000Z');
});

// --- the env override -----------------------------------------------------
test('the lookback floor can be tuned per deployment', () => {
  assert.equal(lookbackDaysFromEnv('X', 14, { X: '30' }), 30);
  assert.equal(lookbackDaysFromEnv('X', 14, { X: '0' }), 0);
  assert.equal(daysBack(computeAmazonSinceDate('2026-08-26', NOW, 30)), 30);
});

test('a nonsense override falls back rather than producing a NaN window', () => {
  // A NaN window compares false against every order date, so the scraper
  // would quietly return nothing at all rather than fail.
  assert.equal(lookbackDaysFromEnv('X', 14, {}), 14);
  assert.equal(lookbackDaysFromEnv('X', 14, { X: '' }), 14);
  assert.equal(lookbackDaysFromEnv('X', 14, { X: 'lots' }), 14);
  assert.equal(lookbackDaysFromEnv('X', 14, { X: '-5' }), 14);
});
