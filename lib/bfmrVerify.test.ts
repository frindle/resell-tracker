/**
 * Tests for the BFMR post-submit verification verdict and fetch breadth.
 *
 *   npm run test:bfmr-verify
 *
 * No test framework is installed in this repo, so these run on Node's built-in
 * runner with type stripping.
 *
 * The live bug (my_tracker_id=4932432): a tracking submission BFMR accepted
 * was reported to the user as an HTTP 502 failure. The submit POST returned
 * OK; only the post-submit read-back failed, because it re-fetched with the
 * DEFAULT filter (filter_tab 'action_needed', filter_status
 * 'reserved,purchased,payment_error,return') -- and submitting tracking moves
 * the row OUT of that slice into a shipped-type status. Same code found the
 * row before the POST and not after, because the row's status changed under
 * it. The fix is breadth: verify must fetch at all-status width so a row that
 * changed status on submit is still visible -- while the tracking_number
 * mismatch check stays fail-closed exactly as before (order 880).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyVerify, WEB_BACKFILL_FETCH, ALL_WEB_STATUSES } from './bfmrVerify.ts';

const MY_TRACKER_ID = 4932432;
const EXPECTED = '9361289725268124778591';

test('a row that changed to a post-submit (shipped-type) status still verifies ok', () => {
  // The exact live shape: BFMR accepted the tracking, and the row now sits in
  // 'shipped' -- outside the default filter_status. Status must not matter to
  // the verdict; only my_tracker_id + tracking_number do.
  const rows = [
    { my_tracker_id: MY_TRACKER_ID, tracking_number: EXPECTED, status: 'shipped' },
  ];
  assert.equal(classifyVerify(rows, MY_TRACKER_ID, EXPECTED), 'ok');
});

test('a row with a different tracking number is a mismatch (order-880 guard)', () => {
  // The real safety net: the row exists but holds someone else's tracking
  // number. This must never be treated as success.
  const rows = [
    { my_tracker_id: MY_TRACKER_ID, tracking_number: '1234567890', status: 'shipped' },
  ];
  assert.equal(classifyVerify(rows, MY_TRACKER_ID, EXPECTED), 'mismatch');
});

test('a genuinely absent row is not-found, never ok', () => {
  assert.equal(classifyVerify([], MY_TRACKER_ID, EXPECTED), 'not-found');
  // A different row carrying the expected number does not rescue the verdict.
  const rows = [{ my_tracker_id: 1234567, tracking_number: EXPECTED }];
  assert.equal(classifyVerify(rows, MY_TRACKER_ID, EXPECTED), 'not-found');
});

test('a null tracking number on the matched row is a mismatch, not ok', () => {
  const rows = [{ my_tracker_id: MY_TRACKER_ID, tracking_number: null }];
  assert.equal(classifyVerify(rows, MY_TRACKER_ID, EXPECTED), 'mismatch');
});

test('the verify fetch breadth covers every status the default filter drops', () => {
  // The regression this whole fix is about: if WEB_BACKFILL_FETCH ever narrows
  // back toward the default slice -- or loses a post-submit status like
  // 'shipped' -- the row disappears from the read-back and a successful submit
  // reads as "(row not found)" again. Assert against the actual constant the
  // verify path uses, so that narrowing re-breaks this test.
  assert.equal(WEB_BACKFILL_FETCH.statuses, ALL_WEB_STATUSES);
  const statuses = new Set(ALL_WEB_STATUSES.split(','));
  for (const s of ['reserved', 'purchased', 'shipped', 'processed']) {
    assert.ok(statuses.has(s), `verify breadth must cover status '${s}'`);
  }
  // And the tab filter must not be the action-needed slice either.
  assert.equal(WEB_BACKFILL_FETCH.tab, 'all');
});
