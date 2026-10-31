import test from 'node:test';
import assert from 'node:assert/strict';
import { bfmrTrackerOutcome } from './syncGroups.ts';

const QUIET = 'tracker ID backfill skipped (web session)';

test('webError from the tracker pull is quiet and never asks for the sidecar', () => {
  for (const webError of ['login 403', 'Error: BFMR fetch tracker 401', 'BFMR fetch tracker 403']) {
    assert.deepEqual(bfmrTrackerOutcome({ ok: true, body: { webError } }), { note: QUIET, needsSidecar: false });
  }
});

test('webError wins over a stale webBackfilled count', () => {
  const o = bfmrTrackerOutcome({ ok: true, body: { webError: 'boom', webBackfilled: 4, synced: 10 } });
  assert.equal(o.needsSidecar, false);
  assert.equal(o.note, QUIET);
});

test('empty-string webError is not an error: normal success outcome', () => {
  assert.deepEqual(bfmrTrackerOutcome({ ok: true, body: { webError: '', webBackfilled: 1 } }), { note: '1 tracker ID linked', needsSidecar: false });
});

test('other outcomes are unchanged', () => {
  assert.deepEqual(bfmrTrackerOutcome({ ok: true, body: { webBackfilled: 3 } }), { note: '3 tracker IDs linked', needsSidecar: false });
  assert.deepEqual(bfmrTrackerOutcome({ ok: true, body: {} }), { note: '', needsSidecar: false });
  assert.deepEqual(bfmrTrackerOutcome({ ok: false, body: null }), { note: 'tracker API failed, using sidecar', needsSidecar: true });
  assert.deepEqual(bfmrTrackerOutcome({ ok: true, body: null }), { note: 'tracker API failed, using sidecar', needsSidecar: true });
});
