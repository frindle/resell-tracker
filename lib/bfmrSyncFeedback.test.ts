import test from 'node:test';
import assert from 'node:assert/strict';
import { MANUAL_SYNC_INIT, syncResultMessage, bfmrPushFailureMessage } from './bfmrSyncFeedback.ts';
import { scopeForSyncTrigger } from './bfmrSyncTrigger.ts';

test('manual sync POST carries trigger: manual as JSON', () => {
  assert.equal(MANUAL_SYNC_INIT.method, 'POST');
  assert.equal(MANUAL_SYNC_INIT.headers['Content-Type'], 'application/json');
  const trigger = JSON.parse(MANUAL_SYNC_INIT.body).trigger;
  assert.equal(trigger, 'manual');
  assert.equal(scopeForSyncTrigger(trigger), 'open');
});

test('webError -> error, no success message', () => {
  assert.deepEqual(syncResultMessage({ synced: 770, webError: 'Error: BFMR fetch tracker 403' }), {
    kind: 'error',
    text: 'BFMR tracker-id backfill failed: Error: BFMR fetch tracker 403',
  });
});

test('webRows 0 without webError -> error', () => {
  assert.deepEqual(syncResultMessage({ synced: 770, webRows: 0, webNeeded: 5, webBackfilled: 0 }), {
    kind: 'error',
    text: 'BFMR tracker-id backfill failed: BFMR returned 0 tracker rows',
  });
});

test('webError wins over webRows 0; empty-string webError does not count', () => {
  assert.match(syncResultMessage({ webError: 'boom', webRows: 0 }).text, /failed: boom$/);
  assert.deepEqual(syncResultMessage({ synced: 3, webError: '' }), { kind: 'success', text: 'Synced 3' });
});

test('partial backfill appends the still-lack suffix with U and A defaults', () => {
  assert.deepEqual(syncResultMessage({ synced: 770, webNeeded: 10, webBackfilled: 4, webUnmatched: 5, webAmbiguous: 1, webRows: 200 }), {
    kind: 'success',
    text: 'Synced 770 -- 6 reservation(s) still lack a BFMR tracker id (unmatched 5, ambiguous 1)',
  });
  assert.equal(
    syncResultMessage({ synced: 1, webNeeded: 2, webBackfilled: 0 }).text,
    'Synced 1 -- 2 reservation(s) still lack a BFMR tracker id (unmatched 0, ambiguous 0)',
  );
});

test('nothing needed / fully backfilled / missing -> exactly the old message', () => {
  assert.equal(syncResultMessage({ synced: 770 }).text, 'Synced 770');
  assert.equal(syncResultMessage({ synced: 770, webNeeded: 0, webBackfilled: 0 }).text, 'Synced 770');
  assert.equal(syncResultMessage({ synced: 770, webNeeded: 4, webBackfilled: 4 }).text, 'Synced 770');
  assert.equal(syncResultMessage({ synced: 770, webNeeded: 4, webBackfilled: 9 }).text, 'Synced 770');
  assert.equal(syncResultMessage({}).text, 'Synced 0');
});

test('auto-linked message is kept, and gets the suffix too', () => {
  assert.equal(syncResultMessage({ synced: 5, autoLinked: 2 }).text, 'Synced 5, auto-linked 2 by order # / tracking');
  assert.equal(
    syncResultMessage({ synced: 5, autoLinked: 2, webNeeded: 3, webBackfilled: 2, webUnmatched: 1 }).text,
    'Synced 5, auto-linked 2 by order # / tracking -- 1 reservation(s) still lack a BFMR tracker id (unmatched 1, ambiguous 0)',
  );
  assert.equal(syncResultMessage({ synced: 5, autoLinked: 0 }).text, 'Synced 5');
});

test('push failure: myTrackerId reason points at the sidecar sync, others pass through', () => {
  const m = bfmrPushFailureMessage('reservation has no myTrackerId -- sync reservations from BFMR first');
  assert.match(m, /sidecar BFMR sync/);
  assert.doesNotMatch(m, /sync reservations from BFMR first/);
  assert.match(bfmrPushFailureMessage('no BFMR tracker id'), /sidecar BFMR sync/);
  assert.equal(bfmrPushFailureMessage('BFMR 500'), 'Link saved, but the order number was NOT pushed to BFMR: BFMR 500');
  assert.equal(bfmrPushFailureMessage(undefined), 'Link saved, but the order number was NOT pushed to BFMR: unknown reason');
});
