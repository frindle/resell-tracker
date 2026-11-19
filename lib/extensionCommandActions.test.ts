import test from 'node:test';
import assert from 'node:assert/strict';
import { planRetry, retryType, retryTarget, canCancel, type QueueRow } from './extensionCommandActions.ts';

const row = (o: Partial<QueueRow> & { id: number }): QueueRow => ({
  type: 'SYNC_AMAZON_PAGES', payload: null, status: 'pending', targetBrowser: 'chrome', ...o,
});

test('retryType: Amazon types stay on the extension, the legacy full sync becomes page capture', () => {
  assert.equal(retryType('SYNC_AMAZON_PAGES'), 'SYNC_AMAZON_PAGES');
  assert.equal(retryType('SYNC_AMAZON'), 'SYNC_AMAZON_PAGES');
  assert.equal(retryType('TRACK_AMAZON'), 'TRACK_AMAZON');
  assert.equal(retryType('SYNC_AMAZON_ORDER'), 'SYNC_AMAZON_ORDER');
  assert.equal(retryType('SYNC_WALMART'), 'SYNC_WALMART');
  assert.equal(retryType('SYNC_BIGSKY'), null);
});

test('retryTarget: Amazon is never the sidecar', () => {
  for (const t of ['SYNC_AMAZON', 'SYNC_AMAZON_PAGES', 'SYNC_AMAZON_ORDER', 'TRACK_AMAZON']) assert.equal(retryTarget(t), 'chrome');
  assert.equal(retryTarget('SYNC_WALMART'), 'sidecar');
  assert.equal(retryTarget('SYNC_COSTCO_ORDER'), 'sidecar');
  assert.equal(retryTarget('SYNC_WALMART_ORDER'), 'sidecar');
  assert.equal(retryType('SYNC_WALMART_ORDER'), 'SYNC_WALMART_ORDER');
  assert.equal(retryTarget('SYNC_BFMR'), null);
});

test('retry of a queued Amazon row already on the extension is a no-op kick', () => {
  const cmd = row({ id: 1 });
  assert.deepEqual(planRetry(cmd, [cmd]), { kind: 'already', id: 1 });
});

test('retry of a stale sidecar-targeted Amazon row re-points it at the extension', () => {
  const cmd = row({ id: 2, type: 'TRACK_AMAZON', targetBrowser: 'sidecar', payload: '{"a":1}' });
  assert.deepEqual(planRetry(cmd, [cmd]), { kind: 'retarget', id: 2, type: 'TRACK_AMAZON', targetBrowser: 'chrome' });
});

test('retry merges into an existing pending extension copy', () => {
  const cmd = row({ id: 3, type: 'TRACK_AMAZON', payload: 'p', targetBrowser: 'sidecar' });
  const copy = row({ id: 4, type: 'TRACK_AMAZON', payload: 'p' });
  assert.deepEqual(planRetry(cmd, [cmd, copy]), { kind: 'merge', deleteId: 3, keepId: 4 });
});

test('retry of a failed legacy SYNC_AMAZON creates one extension page capture', () => {
  const cmd = row({ id: 5, type: 'SYNC_AMAZON', status: 'failed', targetBrowser: 'sidecar' });
  assert.deepEqual(planRetry(cmd, []), { kind: 'create', type: 'SYNC_AMAZON_PAGES', payload: null, targetBrowser: 'chrome' });
});

test('retry of a failed Amazon row does not duplicate a pending extension copy', () => {
  const failed = row({ id: 8, type: 'SYNC_AMAZON_ORDER', status: 'failed', payload: 'p' });
  const copy = row({ id: 9, type: 'SYNC_AMAZON_ORDER', payload: 'p' });
  assert.deepEqual(planRetry(failed, [copy]), { kind: 'already', id: 9 });
});

test('retry of a failed Walmart row goes to the sidecar', () => {
  const failed = row({ id: 12, type: 'SYNC_WALMART', status: 'failed', targetBrowser: 'sidecar' });
  assert.deepEqual(planRetry(failed, []), { kind: 'create', type: 'SYNC_WALMART', payload: null, targetBrowser: 'sidecar' });
});

test('running and unsupported rows are refused', () => {
  assert.equal(planRetry(row({ id: 10, status: 'running' }), []).kind, 'busy');
  assert.equal(planRetry(row({ id: 11, type: 'SYNC_BIGSKY' }), []).kind, 'unsupported');
});

test('only pending rows can be cancelled', () => {
  assert.equal(canCancel('pending'), true);
  assert.equal(canCancel('running'), false);
  assert.equal(canCancel('failed'), false);
});

test('BFMR retry keeps its original target', () => {
  const pend = row({ id: 23, type: 'SYNC_BFMR', targetBrowser: 'chrome' });
  assert.deepEqual(planRetry(pend, [pend]), { kind: 'already', id: 23 });
  const failed = row({ id: 24, type: 'SYNC_BFMR', status: 'failed', targetBrowser: 'chrome' });
  assert.deepEqual(planRetry(failed, []), { kind: 'create', type: 'SYNC_BFMR', payload: null, targetBrowser: 'chrome' });
});
