/**
 * Tests for the bottom-right sync status panel's logic.
 *
 *   npm run test:sync-status
 *
 * No test framework is installed in this repo, so these run on Node's built-in
 * runner with type stripping.
 *
 * The point of this panel is that it reports the real state of the
 * ExtensionCommand queue. So what is worth pinning down is that it never
 * invents a state and never swallows one: a failure message survives to the
 * screen even when the result blob is malformed, and a queued command is
 * still reported as queued no matter how long it has sat there.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  commandLabel,
  isActiveCommand,
  isFinishedCommand,
  isSessionExpiredResult,
  relativeTime,
  summarizeResult,
  visibleCommands,
  STATUS_WORD,
  type ExtCommand,
} from './syncStatus.ts';

const NOW = Date.parse('2026-08-27T18:00:00.000Z');
const KEEP = 3 * 60 * 1000;

function cmd(over: Partial<ExtCommand> & { id: number }): ExtCommand {
  const created = over.createdAt ?? new Date(NOW - 30_000).toISOString();
  return {
    type: 'SYNC_AMAZON',
    status: 'pending',
    result: null,
    claimedBy: null,
    createdAt: created,
    updatedAt: over.updatedAt ?? created,
    ...over,
  };
}

test('the four queue states map to the four words shown', () => {
  assert.equal(STATUS_WORD.pending, 'queued');
  assert.equal(STATUS_WORD.running, 'running');
  assert.equal(STATUS_WORD.done, 'completed');
  assert.equal(STATUS_WORD.failed, 'failed');
  assert.equal(isActiveCommand({ status: 'pending' }), true);
  assert.equal(isActiveCommand({ status: 'running' }), true);
  assert.equal(isActiveCommand({ status: 'done' }), false);
  assert.equal(isFinishedCommand({ status: 'failed' }), true);
  assert.equal(isFinishedCommand({ status: 'running' }), false);
});

test('an unrecognised status is not quietly treated as finished', () => {
  assert.equal(isActiveCommand({ status: 'weird' }), false);
  assert.equal(isFinishedCommand({ status: 'weird' }), false);
  assert.equal(STATUS_WORD['weird'], undefined);   // the raw value is shown instead
});

// --- what the panel shows -------------------------------------------------
test('nothing to report means nothing on screen', () => {
  assert.deepEqual(visibleCommands([], { now: NOW, keepFinishedMs: KEEP }), []);
});

test('a long-finished command is not still on screen', () => {
  const old = cmd({ id: 1, status: 'done', updatedAt: new Date(NOW - KEEP - 1000).toISOString() });
  assert.deepEqual(visibleCommands([old], { now: NOW, keepFinishedMs: KEEP }), []);
});

test('a just-finished command stays up long enough to be read', () => {
  const fresh = cmd({ id: 1, status: 'done', updatedAt: new Date(NOW - 5_000).toISOString() });
  assert.deepEqual(visibleCommands([fresh], { now: NOW, keepFinishedMs: KEEP }).map(c => c.id), [1]);
});

test('a command still in flight is shown however long it has been sitting there', () => {
  // The panel must not decide that a stuck command has stopped mattering.
  const stuck = cmd({ id: 7, status: 'pending', createdAt: new Date(NOW - 6 * 3600 * 1000).toISOString() });
  assert.deepEqual(visibleCommands([stuck], { now: NOW, keepFinishedMs: KEEP }).map(c => c.id), [7]);
});

test('dismissing hides finished commands but not running ones', () => {
  const done = cmd({ id: 1, status: 'done', updatedAt: new Date(NOW - 1000).toISOString() });
  const running = cmd({ id: 2, status: 'running' });
  const shown = visibleCommands([done, running], { now: NOW, keepFinishedMs: KEEP, dismissed: new Set([1, 2]) });
  assert.deepEqual(shown.map(c => c.id), [2]);
});

test('newest first, and no more than the panel can hold', () => {
  const rows = [1, 2, 3, 4, 5].map(i =>
    cmd({ id: i, status: 'running', createdAt: new Date(NOW - i * 1000).toISOString() }));
  const shown = visibleCommands(rows, { now: NOW, keepFinishedMs: KEEP });
  assert.deepEqual(shown.map(c => c.id), [1, 2, 3, 4]);
});

// --- the result blob ------------------------------------------------------
test('a successful sidecar result reads as a count of what changed', () => {
  const r = JSON.stringify({ platform: 'Amazon', scraped: 40, imported: 3, updated: 2, skipped: 35 });
  assert.equal(summarizeResult(r), '3 new · 2 updated · 35 unchanged');
});

test('a zero-change sync still says so rather than going blank', () => {
  assert.equal(summarizeResult(JSON.stringify({ imported: 0, updated: 0, skipped: 12 })), '0 new · 0 updated · 12 unchanged');
});

test('a failure message reaches the screen', () => {
  const r = JSON.stringify({ error: 'Session expired — re-run the interactive login', platform: 'Amazon' });
  assert.equal(summarizeResult(r), 'Session expired — re-run the interactive login');
});

test('a result that is not JSON is shown as-is, never dropped', () => {
  assert.equal(summarizeResult('Error: navigation timeout of 30000ms exceeded'), 'Error: navigation timeout of 30000ms exceeded');
});

test('a result with nothing recognisable in it produces no line, not "undefined"', () => {
  assert.equal(summarizeResult(JSON.stringify({ platform: 'Amazon' })), null);
  assert.equal(summarizeResult(null), null);
  assert.equal(summarizeResult(''), null);
});

test('a result stringified twice on the way in is still read, not printed raw', () => {
  // The PATCH route stringifies whatever it receives, so a caller that
  // stringified first lands a JSON string inside a JSON string.
  const inner = JSON.stringify({ imported: 2, updated: 1, skipped: 9, receiptsLinked: 3 });
  assert.equal(summarizeResult(JSON.stringify(inner)), '2 new · 1 updated · 9 unchanged · 3 receipts linked');
  assert.equal(summarizeResult(JSON.stringify(JSON.stringify({ error: 'Session expired' }))), 'Session expired');
});

// --- session-expiry detection ---------------------------------------------
test('the real sidecar SessionExpiredError is recognised regardless of site', () => {
  assert.equal(isSessionExpiredResult(JSON.stringify({ error: 'amazon session expired or not logged in' })), true);
  assert.equal(isSessionExpiredResult(JSON.stringify({ error: 'walmart session expired or not logged in' })), true);
});

test('an unrelated failure is not mistaken for a session expiry', () => {
  assert.equal(isSessionExpiredResult(JSON.stringify({ error: 'navigation timeout of 30000ms exceeded' })), false);
  assert.equal(isSessionExpiredResult(null), false);
});

test('a plain string result is shown, not unwrapped into nothing', () => {
  assert.equal(summarizeResult(JSON.stringify('scrape timed out')), 'scrape timed out');
});

test('an overlong result is truncated rather than blowing out the panel', () => {
  const long = 'x'.repeat(500);
  assert.equal(summarizeResult(long)!.length, 160);
  assert.equal(summarizeResult(JSON.stringify({ error: long }))!.length, 160);
});

test('receipt linking is reported when the Costco sync did any', () => {
  assert.equal(
    summarizeResult(JSON.stringify({ imported: 1, updated: 0, skipped: 4, receiptsLinked: 2 })),
    '1 new · 0 updated · 4 unchanged · 2 receipts linked',
  );
});

test('a scrape-only result falls back to what it scraped', () => {
  assert.equal(summarizeResult(JSON.stringify({ scraped: 18 })), '18 scraped');
});

// --- labels and time ------------------------------------------------------
test('command types read as English, including ones with no explicit label', () => {
  assert.equal(commandLabel('SYNC_AMAZON'), 'Amazon sync');
  assert.equal(commandLabel('SCRAPE_CBM'), 'Cashback rates');
  assert.equal(commandLabel('SOME_NEW_COMMAND'), 'Some New Command');
});

test('relative time is relative to the moment asked about, not the wall clock', () => {
  const at = (ms: number) => relativeTime(new Date(NOW - ms).toISOString(), NOW);
  assert.equal(at(2_000), 'just now');
  assert.equal(at(45_000), '45s ago');
  assert.equal(at(5 * 60_000), '5m ago');
  assert.equal(at(2 * 3600_000), '2h ago');
});

test('a clock skewed into the future does not produce a negative age', () => {
  assert.equal(relativeTime(new Date(NOW + 60_000).toISOString(), NOW), 'just now');
});
