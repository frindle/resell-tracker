import test from 'node:test';
import assert from 'node:assert/strict';
import { planRetry, sidecarRetryType, sidecarServes, canCancel, type QueueRow } from './extensionCommandActions.ts';

const ON = { SIDECAR_AMAZON_ENABLED: '1' };
const row = (o: Partial<QueueRow> & { id: number }): QueueRow => ({
  type: 'SYNC_AMAZON_PAGES', payload: null, status: 'pending', targetBrowser: 'chrome', ...o,
});

test('sidecarRetryType maps the page capture to the sidecar sync and rejects extension-only types', () => {
  assert.equal(sidecarRetryType('SYNC_AMAZON_PAGES'), 'SYNC_AMAZON');
  assert.equal(sidecarRetryType('TRACK_AMAZON'), 'TRACK_AMAZON');
  assert.equal(sidecarRetryType('SYNC_BIGSKY'), null);
});

test('retry of a queued extension row re-points it instead of duplicating', () => {
  const cmd = row({ id: 1 });
  assert.deepEqual(planRetry(cmd, [cmd], ON), { kind: 'retarget', id: 1, type: 'SYNC_AMAZON', targetBrowser: 'sidecar' });
});

test('retry of a row already on the sidecar queue is a no-op kick', () => {
  const cmd = row({ id: 2, type: 'TRACK_AMAZON', targetBrowser: 'sidecar', payload: '{"a":1}' });
  assert.deepEqual(planRetry(cmd, [cmd], ON), { kind: 'already', id: 2 });
});

test('retry merges into an existing pending sidecar copy', () => {
  const cmd = row({ id: 3, type: 'TRACK_AMAZON', payload: 'p' });
  const copy = row({ id: 4, type: 'TRACK_AMAZON', payload: 'p', targetBrowser: 'sidecar' });
  assert.deepEqual(planRetry(cmd, [cmd, copy], ON), { kind: 'merge', deleteId: 3, keepId: 4 });
});

test('retry of a failed row creates one new sidecar command', () => {
  const cmd = row({ id: 5, type: 'SYNC_AMAZON', status: 'failed', targetBrowser: 'sidecar' });
  assert.deepEqual(planRetry(cmd, [], ON), { kind: 'create', type: 'SYNC_AMAZON', payload: null, targetBrowser: 'sidecar' });
});

test('retry of a failed row reuses a waiting extension handoff rather than adding another', () => {
  const failed = row({ id: 6, type: 'TRACK_AMAZON', status: 'failed', targetBrowser: 'sidecar', payload: 'p' });
  const handoff = row({ id: 7, type: 'TRACK_AMAZON', payload: 'p', targetBrowser: 'chrome' });
  assert.deepEqual(planRetry(failed, [handoff], ON), { kind: 'retarget', id: 7, type: 'TRACK_AMAZON', targetBrowser: 'sidecar' });
});

test('retry of a failed row does not duplicate a pending sidecar copy', () => {
  const failed = row({ id: 8, type: 'SYNC_AMAZON', status: 'failed' });
  const copy = row({ id: 9, type: 'SYNC_AMAZON', targetBrowser: 'sidecar' });
  assert.deepEqual(planRetry(failed, [copy], ON), { kind: 'already', id: 9 });
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

test('sidecarServes mirrors the sidecar enable flags', () => {
  assert.equal(sidecarServes('SYNC_AMAZON', {}), false);
  assert.equal(sidecarServes('SYNC_AMAZON_ORDER', {}), false);
  assert.equal(sidecarServes('SYNC_AMAZON', ON), true);
  assert.equal(sidecarServes('SYNC_WALMART', {}), true);
  assert.equal(sidecarServes('SYNC_BFMR', ON), false);
  assert.equal(sidecarServes('TRACK_AMAZON', {}), true);
  assert.equal(sidecarServes('TRACK_AMAZON', { SIDECAR_AMAZON_TRACKING: '0' }), false);
});

test('Amazon retry stays on the extension while the sidecar Amazon sync is off', () => {
  const pages = row({ id: 20, status: 'failed' });
  assert.deepEqual(planRetry(pages, [], {}), { kind: 'create', type: 'SYNC_AMAZON_PAGES', payload: null, targetBrowser: 'chrome' });
  const pend = row({ id: 21 });
  assert.deepEqual(planRetry(pend, [pend], {}), { kind: 'already', id: 21 });
  const order = row({ id: 22, type: 'SYNC_AMAZON_ORDER', payload: 'p' });
  assert.deepEqual(planRetry(order, [order], {}), { kind: 'already', id: 22 });
});

test('BFMR retry keeps its original target', () => {
  const pend = row({ id: 23, type: 'SYNC_BFMR', targetBrowser: 'chrome' });
  assert.deepEqual(planRetry(pend, [pend], ON), { kind: 'already', id: 23 });
  const failed = row({ id: 24, type: 'SYNC_BFMR', status: 'failed', targetBrowser: 'chrome' });
  assert.deepEqual(planRetry(failed, [], ON), { kind: 'create', type: 'SYNC_BFMR', payload: null, targetBrowser: 'chrome' });
});
