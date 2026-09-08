/**
 * Accept/verify decoupling for per-reservation BFMR tracking submits.
 *
 * The live defect this exists to fix (order 111-3026367-4750648, iPad Air 8):
 * the submit route POSTed the tracking to BFMR — BFMR ACCEPTED it and sent a
 * confirmation email — but then blocked on a post-submit VERIFY read-back.
 * BFMR's read API was lagging (10s+ syncs), the verify fetch had no timeout,
 * and because the local BfmrSubmittedShipment record is only written after
 * verify resolves, the UI sat on "Submitting…" / "0 of 1 already submitted"
 * forever even though BFMR already had the tracking.
 *
 * The rule this module encodes:
 *   1. ACCEPT and VERIFY are decoupled. The instant BFMR accepts the POST
 *      (2xx), the local submission record is persisted and the caller may
 *      report success — "1 of 1 submitted". Nothing about the response waits
 *      on the verify read-back.
 *   2. Verify is a NON-BLOCKING reconciliation: bounded, hard-timeout fetches
 *      (enforced where the fetch happens, in bfmrWeb.ts), whose only job is
 *      to flag a MISMATCH later. A slow or hanging BFMR read must never hang
 *      the UI and must never revert a recorded submission — so reconcile()
 *      runs detached after we return, and its failure can never reject us.
 *   3. IDEMPOTENCY: once rows are recorded locally (BfmrSubmittedShipment),
 *      repeating them is a no-op — isAlreadyRecorded() lets the route answer
 *      "already submitted" WITHOUT re-POSTing to BFMR, which is exactly the
 *      double-upload risk the original hang created.
 *
 * Pure on purpose (no imports): same rule as bfmrVerify.ts / bfmrJoin.ts —
 * this has to be exercisable under plain `node --experimental-strip-types`
 * without dragging in the DB or fetch. The real POST, record, and reconcile
 * work is injected by the route.
 */

export type SubmitRow = { qty: number; trackingNumber: string };
export type ShipmentRecord = { qty: number; trackingNumber: string };

/**
 * Idempotency decision: are ALL requested rows already covered by locally
 * recorded shipments? A row is covered when the sum of records carrying its
 * exact tracking number reaches its qty. This is what makes a retry after an
 * accepted-but-unconfirmed submit a no-op instead of a second upload to BFMR.
 */
export function isAlreadyRecorded(
  records: readonly ShipmentRecord[],
  rows: readonly SubmitRow[],
): boolean {
  if (rows.length === 0) return false; // nothing requested, nothing to confirm
  for (const row of rows) {
    const covered = records
      .filter(r => r.trackingNumber === row.trackingNumber)
      .reduce((sum, r) => sum + r.qty, 0);
    if (covered < row.qty) return false;
  }
  return true;
}

export type SubmitFlowDeps = {
  /** The POST to BFMR. Resolving means BFMR ACCEPTED it (2xx). Must throw on
   * rejection or any pre-POST failure — then nothing is recorded and the
   * caller reports the error exactly as before (409 safe-to-retry vs 502
   * may-have-reached-BFMR). */
  postToBfmr: () => Promise<void>;
  /** Persist the local submission record. Runs ONLY after accept, and must
   * complete BEFORE we return — the UI's "1 of 1 submitted" is derived from
   * this row on its reload. */
  recordSubmission: () => Promise<void>;
  /** The non-blocking verify reconciliation (bounded + hard-timeout fetches).
   * Runs detached after we return; a rejection here can never fail an
   * accepted submit or revert the recorded submission. Optional — omit to
   * skip reconciliation entirely. */
  reconcile?: (() => Promise<unknown>) | null;
};

export type SubmitFlowResult = { accepted: true };

/**
 * accept → record → (detached) reconcile. Returns as soon as BFMR has
 * accepted the POST and the local record is persisted — never waits on
 * `reconcile`, so a hanging/slow verify read-back cannot hold the response
 * open or leave the UI in "Submitting…".
 */
export async function submitAndReconcile(deps: SubmitFlowDeps): Promise<SubmitFlowResult> {
  // 1. Accept. Any throw (BFMR rejected, pre-POST failure) propagates before
  //    anything is recorded — same error semantics as the old blocking flow.
  await deps.postToBfmr();

  // 2. Record locally NOW. This is what flips the UI to "submitted" and what
  //    makes a later repeat of these rows an idempotent no-op (requirement 3).
  await deps.recordSubmission();

  // 3. Reconcile, detached: its only job is to flag a mismatch LATER (the
  //    route's closure logs it). A slow/hanging BFMR read — or any rejection —
  //    must never reject this promise, so swallow with a log instead of an
  //    unhandled rejection.
  if (deps.reconcile) {
    const reconcile = deps.reconcile;
    void Promise.resolve()
      .then(() => reconcile())
      .catch((e) => console.warn('[bfmrSubmitFlow] post-submit reconciliation failed:', e));
  }

  return { accepted: true };
}
