/**
 * Tests for the accept/verify decoupling of per-reservation BFMR submits.
 *
 *   npm run test
 *
 * No test framework is installed in this repo, so these run on Node's built-in
 * runner with type stripping (bfmrSubmitFlow.ts is pure — no imports).
 *
 * The live defect under test (order 111-3026367-4750648): BFMR ACCEPTED the
 * tracking POST and sent a confirmation email, but the route blocked on a
 * post-submit VERIFY read-back against a lagging BFMR read API. The local
 * BfmrSubmittedShipment record was only written after verify resolved, so the
 * UI sat on "Submitting…" / "0 of 1 already submitted" forever. The fix:
 *   (a) accept + record must resolve to "submitted" even when the verify
 *       read-back hangs indefinitely — reconcile runs detached;
 *   (b) a recorded submission must NOT re-POST to BFMR on a second call —
 *       isAlreadyRecorded makes the repeat an idempotent no-op.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { isAlreadyRecorded, submitAndReconcile } from './bfmrSubmitFlow.ts';

const TRACKING = 'TBA334443592549'; // the live order's tracking number
const ROWS = [{ qty: 1, trackingNumber: TRACKING }];

// --- isAlreadyRecorded: the idempotency decision ---------------------------

test('isAlreadyRecorded: exact match of one row is already recorded', () => {
  assert.equal(isAlreadyRecorded([{ qty: 1, trackingNumber: TRACKING }], ROWS), true);
});

test('isAlreadyRecorded: partial coverage (record qty < row qty) is NOT covered', () => {
  // A qty-2 link with only a qty-1 record must still be submittable — the
  // remaining unit genuinely has not been pushed.
  assert.equal(isAlreadyRecorded([{ qty: 1, trackingNumber: TRACKING }], [{ qty: 2, trackingNumber: TRACKING }]), false);
});

test('isAlreadyRecorded: a different tracking number never covers the row', () => {
  assert.equal(
    isAlreadyRecorded([{ qty: 5, trackingNumber: '1Z999AA10123456784' }], ROWS),
    false,
  );
});

test('isAlreadyRecorded: multiple rows are covered only when EVERY row is', () => {
  const records = [
    { qty: 1, trackingNumber: TRACKING },
    { qty: 2, trackingNumber: '1Z999AA10123456784' },
  ];
  assert.equal(
    isAlreadyRecorded(records, [{ qty: 1, trackingNumber: TRACKING }, { qty: 2, trackingNumber: '1Z999AA10123456784' }]),
    true,
  );
  // One row covered, one not -> the batch is NOT already recorded.
  assert.equal(
    isAlreadyRecorded(records, [{ qty: 1, trackingNumber: TRACKING }, { qty: 1, trackingNumber: 'TBA0000000000' }]),
    false,
  );
});

test('isAlreadyRecorded: split records for the same number sum up', () => {
  // Two qty-1 records with the same tracking cover a qty-2 row.
  assert.equal(
    isAlreadyRecorded([
      { qty: 1, trackingNumber: TRACKING },
      { qty: 1, trackingNumber: TRACKING },
    ], [{ qty: 2, trackingNumber: TRACKING }]),
    true,
  );
});

test('isAlreadyRecorded: no records -> never already recorded', () => {
  assert.equal(isAlreadyRecorded([], ROWS), false);
});

// --- submitAndReconcile: accept resolves without waiting on verify ---------

function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms));
}

test('BFMR-accept with a HANGING verify read-back still resolves to submitted (no indefinite pending)', async () => {
  // THE live-defect test: reconcile never settles — exactly what happened when
  // BFMR's lagging read API held the old blocking verify open forever. The
  // submit must resolve promptly, with the local record already written.
  let recorded = false;
  const hangingVerify = new Promise<never>(() => { /* never resolves */ });

  const resultPromise = submitAndReconcile({
    postToBfmr: async () => { /* BFMR accepted (2xx) */ },
    recordSubmission: async () => { recorded = true; },
    reconcile: async () => { await hangingVerify; throw new Error('unreachable'); },
  });

  // Must resolve on its own schedule, not wait for the hung read-back.
  const result = await Promise.race([resultPromise, timeout(50)]);
  assert.equal(result.accepted, true);
  assert.equal(recorded, true, 'the local submission record is written before we return');
});

test('a reconcile FAILURE (mismatch/timeout) does not fail an accepted submit', async () => {
  // Verify's only job is to flag a mismatch later. A rejection — hung fetch,
  // aborted timeout, whatever — must never reject the already-accepted flow or
  // revert the recorded submission.
  let recorded = false;
  const result = await Promise.race([
    submitAndReconcile({
      postToBfmr: async () => {},
      recordSubmission: async () => { recorded = true; },
      reconcile: async () => { throw new Error('BFMR request timed out after 8000ms'); },
    }),
    timeout(50),
  ]);
  assert.equal(result.accepted, true);
  assert.equal(recorded, true);
});

test('a REJECTED POST records nothing and surfaces the error', async () => {
  // Pre-accept failures keep their old semantics: BFMR rejected (or was never
  // reached) -> no local record, caller reports the error.
  let recorded = false;
  await assert.rejects(
    submitAndReconcile({
      postToBfmr: async () => { throw new Error('BFMR submit reservation tracking 502'); },
      recordSubmission: async () => { recorded = true; },
      reconcile: async () => {},
    }),
    /502/,
  );
  assert.equal(recorded, false, 'a rejected POST must not be recorded as submitted');
});

test('record failure after accept propagates (route reports may-have-reached-BFMR)', async () => {
  // If the local write fails AFTER BFMR accepted, we must NOT report success —
  // but reconcile must not have run either; the route's 502 path handles it.
  await assert.rejects(
    submitAndReconcile({
      postToBfmr: async () => {},
      recordSubmission: async () => { throw new Error('db down'); },
      reconcile: async () => {},
    }),
    /db down/,
  );
});

// --- idempotency across calls: no double-submit -----------------------------

test('a recorded submission does not re-POST to BFMR on a second call', async () => {
  // Models the route's guard around submitAndReconcile. The live hang created
  // exactly this risk: user sees "Submitting…" forever, clicks again (or the
  // client retries) — and if the first one had landed at BFMR (the email
  // proves it can), a second POST is a double upload. Once recorded locally,
  // the repeat must be answered from the local record alone.
  let records: { qty: number; trackingNumber: string }[] = [];
  let postsToBfmr = 0;

  const submitOnce = async () => {
    if (isAlreadyRecorded(records, ROWS)) return { alreadySubmitted: true };
    await submitAndReconcile({
      postToBfmr: async () => { postsToBfmr++; },
      recordSubmission: async () => { records.push(...ROWS); },
      reconcile: undefined, // not under test here
    });
    return { alreadySubmitted: false };
  };

  const first = await submitOnce();
  assert.equal(first.alreadySubmitted, false);
  assert.equal(postsToBfmr, 1, 'the first call POSTs exactly once');

  const second = await submitOnce();
  assert.equal(second.alreadySubmitted, true, 'the repeat is answered as already submitted');
  assert.equal(postsToBfmr, 1, 'a recorded submission must NOT re-POST to BFMR');

  // Even a third call stays a no-op.
  const third = await submitOnce();
  assert.equal(third.alreadySubmitted, true);
  assert.equal(postsToBfmr, 1);
});

test('the guard does not block a genuinely NEW row on the same reservation', async () => {
  // A different tracking number (a second shipment of a split reservation) is
  // NOT already recorded and must still POST.
  let records: { qty: number; trackingNumber: string }[] = [{ qty: 1, trackingNumber: TRACKING }];
  const newRows = [{ qty: 1, trackingNumber: 'TBA5555555555' }];
  assert.equal(isAlreadyRecorded(records, newRows), false);

  let postsToBfmr = 0;
  await submitAndReconcile({
    postToBfmr: async () => { postsToBfmr++; },
    recordSubmission: async () => { records.push(...newRows); },
  });
  assert.equal(postsToBfmr, 1);
});
