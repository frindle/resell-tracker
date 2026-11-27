import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSyncReply, syncMessage } from './bigskySyncResult.ts';

test('parseSyncReply reads JSON', () => {
  assert.deepEqual(parseSyncReply(200, '{"synced":3}'), { synced: 3 });
});

test('parseSyncReply falls back on a non-JSON body', () => {
  assert.deepEqual(parseSyncReply(502, '<html>'), { error: 'Sync failed: HTTP 502 (non-JSON response)' });
});

test('syncMessage reports counts and notes', () => {
  assert.deepEqual(syncMessage({ synced: 4 }), { ok: true, text: 'Synced 4 commitments' });
  assert.deepEqual(
    syncMessage({ synced: 2, skipped: 1, fulfillmentsWithoutTracking: 3 }),
    { ok: true, text: 'Synced 2 commitments (1 unreadable, 3 fulfillments with no scan found)' },
  );
});

test('syncMessage reports an error', () => {
  assert.deepEqual(syncMessage({ error: 'not connected' }), { ok: false, text: 'not connected' });
});
