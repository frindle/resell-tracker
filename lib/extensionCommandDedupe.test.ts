/**
 * Regression tests for POST /api/extension/commands dedupe.
 *
 * The bug: the route only reused an existing command while it was still
 * 'pending'. The sidecar flips a command to 'running' the moment it claims
 * it (kicked via /poll-now, so within ~1s), so a second Sync Amazon click
 * during the ~17-100s scrape always created a second SYNC_AMAZON row that
 * ran the list scrape again right after the first.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { extensionCommandDedupeWhere, canonicalCommandPayload, retryDedupeWhere, RUNNING_DEDUPE_MAX_AGE_MS } from './extensionCommandDedupe.ts';

const now = new Date('2026-10-22T23:33:30Z');
const cutoff = new Date(now.getTime() - RUNNING_DEDUPE_MAX_AGE_MS);

test('a payload-less sync dedupes against pending AND recently-running rows of the same type/target', () => {
  assert.deepEqual(extensionCommandDedupeWhere('SYNC_AMAZON', 'sidecar', undefined, now), {
    type: 'SYNC_AMAZON',
    targetBrowser: 'sidecar',
    OR: [{ status: 'pending' }, { status: 'running', updatedAt: { gte: cutoff } }],
  });
});

test('a running row older than the cutoff (orphaned by a sidecar restart) no longer swallows new clicks', () => {
  const w = extensionCommandDedupeWhere('SYNC_AMAZON', 'sidecar', null, now);
  const running = w.OR.find(c => c.status === 'running') as { updatedAt: { gte: Date } };
  assert.equal(running.updatedAt.gte.getTime(), now.getTime() - 15 * 60 * 1000);
});

test('a command carrying a payload only dedupes against pending rows (a running one may cover different orders)', () => {
  assert.deepEqual(extensionCommandDedupeWhere('SYNC_AMAZON_ORDER', 'sidecar', { orderNumbers: ['111-1'] }, now), {
    type: 'SYNC_AMAZON_ORDER',
    targetBrowser: 'sidecar',
    OR: [{ status: 'pending' }],
  });
});

test('untargeted commands keep a null target in the match', () => {
  assert.equal(extensionCommandDedupeWhere('SYNC_BIGSKY', null, undefined, now).targetBrowser, null);
});

test('retry of a per-order command only reuses a pending row with the same payload', () => {
  const a = JSON.stringify({ orderNumbers: ['111-0000001-0000001'] });
  assert.deepEqual(retryDedupeWhere('SYNC_AMAZON_ORDER', 'sidecar', a, now), {
    type: 'SYNC_AMAZON_ORDER',
    targetBrowser: 'sidecar',
    OR: [{ status: 'pending' }],
    payload: a,
  });
});

test('SCRAPE_EGIFT dedupes on its payload: same order matches, another order does not', () => {
  const a = extensionCommandDedupeWhere('SCRAPE_EGIFT', 'chrome', { orderId: 7 }, now);
  assert.equal(a.payload, '{"orderId":7}');
  assert.deepEqual(a.OR, [{ status: 'pending' }]);
  assert.notEqual(extensionCommandDedupeWhere('SCRAPE_EGIFT', 'chrome', { orderId: 8 }, now).payload, a.payload);
});

test('canonicalCommandPayload fixes the key order for SCRAPE_EGIFT only', () => {
  const p = canonicalCommandPayload('SCRAPE_EGIFT', { extra: 1, orderId: 7 });
  assert.equal(JSON.stringify(p), '{"orderId":7}');
  const other = { b: 1, a: 2 };
  assert.equal(canonicalCommandPayload('SYNC_AMAZON_ORDER', other), other);
});

test('retry of a payload-less sync keeps the normal dedupe (pending or recently running)', () => {
  assert.deepEqual(retryDedupeWhere('SYNC_AMAZON', 'sidecar', null, now), extensionCommandDedupeWhere('SYNC_AMAZON', 'sidecar', null, now));
  assert.equal('payload' in retryDedupeWhere('SYNC_AMAZON', 'sidecar', null, now), false);
});
