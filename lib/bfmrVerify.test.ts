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

import { classifyVerify, verifySubmission, WEB_BACKFILL_FETCH, ALL_WEB_STATUSES, type TrackerFetchOptions } from './bfmrVerify.ts';

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

test('an empty tracking number on the matched row is pending (read-after-write lag), not ok', () => {
  // The live 502 on my_tracker_id=4939069: BFMR accepted TBA334421203888 and
  // the row was already in a shipped-type status, but its tracking_number had
  // not propagated at read-back time. That shape must be retryable lag, NOT
  // an immediate mismatch -- while still never being 'ok'.
  const rows = [{ my_tracker_id: MY_TRACKER_ID, tracking_number: null }];
  assert.equal(classifyVerify(rows, MY_TRACKER_ID, EXPECTED), 'pending');
  const blank = [{ my_tracker_id: MY_TRACKER_ID, tracking_number: '' }];
  assert.equal(classifyVerify(blank, MY_TRACKER_ID, EXPECTED), 'pending');
  const padded = [{ my_tracker_id: MY_TRACKER_ID, tracking_number: '   ' }];
  assert.equal(classifyVerify(padded, MY_TRACKER_ID, EXPECTED), 'pending');
});

test('a different non-empty tracking number is still a mismatch (order-880 guard)', () => {
  // The distinction that keeps the guard honest: empty = lag (retryable),
  // someone else's number = conflict (fail closed immediately).
  const rows = [{ my_tracker_id: MY_TRACKER_ID, tracking_number: 'TBA9999999999' }];
  assert.equal(classifyVerify(rows, MY_TRACKER_ID, EXPECTED), 'mismatch');
});

test('comparison is trim-normalized on both sides', () => {
  const rows = [{ my_tracker_id: MY_TRACKER_ID, tracking_number: ` ${EXPECTED} ` }];
  assert.equal(classifyVerify(rows, MY_TRACKER_ID, EXPECTED), 'ok');
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

// --- verifySubmission: the call-site breadth guard + bounded retry ---------
//
// The constant-level test above only proves WEB_BACKFILL_FETCH is wide enough;
// it cannot catch someone reverting the actual verify re-fetch to
// fetchTrackerRows' default filter (every test would still pass and the 502
// bug returns). These tests close that gap with a spy fetcher that records
// the opts it was called with, plus an injected no-op sleep so nothing waits.

type VerifyRow = { my_tracker_id: number; tracking_number: string | null };

function makeFetcher(results: VerifyRow[][]) {
  const calls: TrackerFetchOptions[] = [];
  let i = 0;
  // Repeats the last result once exhausted, so "always empty" / "row from
  // attempt N on" are both expressible.
  const fetchRows = async (opts: TrackerFetchOptions): Promise<VerifyRow[]> => {
    calls.push(opts);
    return results[Math.min(i++, results.length - 1)];
  };
  return { fetchRows, calls };
}

function makeSleep() {
  const sleeps: number[] = [];
  // No-op on purpose: tests must not actually wait.
  const sleep = async (ms: number) => { sleeps.push(ms); };
  return { sleep, sleeps };
}

test('verifySubmission fetches at WEB_BACKFILL_FETCH breadth (call-site guard)', () => {
  // THE Gap-1 test: if the verify re-fetch ever reverts to the default filter
  // (tab 'action_needed', narrow statuses), this goes RED -- the spy records
  // exactly what opts the orchestrator passed, not just that the constant is
  // wide.
  const { fetchRows, calls } = makeFetcher([[{ my_tracker_id: MY_TRACKER_ID, tracking_number: EXPECTED }]]);
  const { sleep } = makeSleep();
  return verifySubmission(fetchRows, MY_TRACKER_ID, EXPECTED, { sleep }).then(() => {
    assert.equal(calls.length, 1);
    // Same object the orchestrator hands to every fetcher call.
    assert.equal(calls[0], WEB_BACKFILL_FETCH);
    assert.equal(calls[0].tab, 'all');
    assert.equal(calls[0].statuses, ALL_WEB_STATUSES);
  });
});

test('verifySubmission: ok on a shipped-status row, no retry', () => {
  const { fetchRows, calls } = makeFetcher([[{ my_tracker_id: MY_TRACKER_ID, tracking_number: EXPECTED }]]);
  const { sleep, sleeps } = makeSleep();
  return verifySubmission(fetchRows, MY_TRACKER_ID, EXPECTED, { sleep }).then(r => {
    assert.equal(r.verdict, 'ok');
    assert.equal(r.actual, EXPECTED);
    assert.equal(calls.length, 1, 'a clean ok must not be retried');
    assert.equal(sleeps.length, 0);
  });
});

test('verifySubmission: mismatch fails closed immediately (order-880 guard)', () => {
  // The row exists but holds a different tracking number. This must return on
  // the FIRST attempt -- never retried into success.
  const other = '1234567890';
  const { fetchRows, calls } = makeFetcher([[{ my_tracker_id: MY_TRACKER_ID, tracking_number: other }]]);
  const { sleep, sleeps } = makeSleep();
  return verifySubmission(fetchRows, MY_TRACKER_ID, EXPECTED, { sleep }).then(r => {
    assert.equal(r.verdict, 'mismatch');
    assert.equal(r.actual, other, 'actual carries the row\'s real number for the error message');
    assert.equal(calls.length, 1, 'a mismatch must NOT be retried');
    assert.equal(sleeps.length, 0);
  });
});

test('verifySubmission: not-found retries then gives up', () => {
  // Always empty. Default attempts=3 -> fetcher called 3 times, sleep called
  // attempts-1 = 2 times (no pointless wait after the last attempt).
  const { fetchRows, calls } = makeFetcher([[]]);
  const { sleep, sleeps } = makeSleep();
  return verifySubmission(fetchRows, MY_TRACKER_ID, EXPECTED, { sleep }).then(r => {
    assert.equal(r.verdict, 'not-found');
    assert.equal(r.actual, null);
    assert.equal(calls.length, 3);
    assert.equal(sleeps.length, 2);
  });
});

test('verifySubmission: transient absence self-heals on retry', () => {
  // Read-after-write lag: attempt 1 sees no row (BFMR hasn't propagated the
  // write yet), attempt 2 sees it. The bounded retry recovers a submission
  // BFMR actually accepted instead of false-failing 502.
  const { fetchRows, calls } = makeFetcher([[], [{ my_tracker_id: MY_TRACKER_ID, tracking_number: EXPECTED }]]);
  const { sleep, sleeps } = makeSleep();
  return verifySubmission(fetchRows, MY_TRACKER_ID, EXPECTED, { sleep }).then(r => {
    assert.equal(r.verdict, 'ok');
    assert.equal(r.actual, EXPECTED);
    assert.equal(calls.length, 2);
    assert.equal(sleeps.length, 1);
  });
});

test('verifySubmission: pending (empty number) retries, then recovers when the write lands', () => {
  // The live shape of my_tracker_id=4939069: attempt 1 sees the row already in
  // its post-submit status but with tracking_number still empty; attempt 2
  // sees BFMR's accepted number. Bounded retry recovers a submission BFMR
  // actually accepted instead of false-failing 502.
  const { fetchRows, calls } = makeFetcher([
    [{ my_tracker_id: MY_TRACKER_ID, tracking_number: '' }],
    [{ my_tracker_id: MY_TRACKER_ID, tracking_number: EXPECTED }],
  ]);
  const { sleep, sleeps } = makeSleep();
  return verifySubmission(fetchRows, MY_TRACKER_ID, EXPECTED, { sleep }).then(r => {
    assert.equal(r.verdict, 'ok');
    assert.equal(r.actual, EXPECTED);
    assert.equal(calls.length, 2);
    assert.equal(sleeps.length, 1);
  });
});

test('verifySubmission: pending that STAYS empty fails closed after retries (guard preserved)', () => {
  // BFMR accepted the POST but the row never shows the number. This must NOT
  // be recorded as success -- verdict 'pending' with an empty actual is what
  // makes submitTrackingForReservation throw, exactly like not-found.
  const { fetchRows, calls } = makeFetcher([[{ my_tracker_id: MY_TRACKER_ID, tracking_number: null }]]);
  const { sleep, sleeps } = makeSleep();
  return verifySubmission(fetchRows, MY_TRACKER_ID, EXPECTED, { sleep }).then(r => {
    assert.equal(r.verdict, 'pending');
    assert.equal(r.actual, null);
    assert.equal(calls.length, 3, 'bounded: default attempts=3');
    assert.equal(sleeps.length, 2);
  });
});

test('verifySubmission: mismatch is never retried into success (revert-test)', () => {
  // Adversarial: attempt 1 shows someone else\'s number; even though the
  // fetcher would "later" return the expected value, a mismatch must fail on
  // FIRST sight and the loop must stop -- retrying past it is exactly how the
  // order-880 guard could be silently defeated.
  const { fetchRows, calls } = makeFetcher([
    [{ my_tracker_id: MY_TRACKER_ID, tracking_number: '1234567890' }],
    [{ my_tracker_id: MY_TRACKER_ID, tracking_number: EXPECTED }],
  ]);
  const { sleep, sleeps } = makeSleep();
  return verifySubmission(fetchRows, MY_TRACKER_ID, EXPECTED, { sleep }).then(r => {
    assert.equal(r.verdict, 'mismatch');
    assert.equal(r.actual, '1234567890');
    assert.equal(calls.length, 1, 'a mismatch must NOT be retried -- not even toward ok');
    assert.equal(sleeps.length, 0);
  });
});

test('verifySubmission: honors explicit attempts and delayMs', () => {
  const { fetchRows, calls } = makeFetcher([[]]);
  const { sleep, sleeps } = makeSleep();
  return verifySubmission(fetchRows, MY_TRACKER_ID, EXPECTED, { attempts: 5, delayMs: 250, sleep }).then(r => {
    assert.equal(r.verdict, 'not-found');
    assert.equal(calls.length, 5);
    assert.deepEqual(sleeps, [250, 250, 250, 250]);
  });
});
