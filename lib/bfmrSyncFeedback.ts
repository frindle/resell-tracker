// Pure user-facing feedback for the BFMR reservation linker, split out of
// components/BfmrReservationLinker.tsx so the decisions are unit-testable.
//
// The sync route reports the tracker-id (myTrackerId) backfill outcome in
// webError / webNeeded / webBackfilled / webUnmatched / webAmbiguous / webRows.
// The linker used to ignore all of them and show a plain "Synced N" even when
// the backfill failed and reservations still had no tracker id.

/** fetch() init for the Sync button: a body-less POST never reaches the route's
 *  trigger -> scope policy as 'manual'. */
export const MANUAL_SYNC_INIT = {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ trigger: 'manual' }),
} as const;

export type SyncResponseData = {
  synced?: number;
  autoLinked?: number;
  webError?: string | null;
  webNeeded?: number;
  webBackfilled?: number;
  webUnmatched?: number;
  webAmbiguous?: number;
  webRows?: number;
};

export type SyncResultMessage = { kind: 'error' | 'success'; text: string };

export function syncResultMessage(d: SyncResponseData): SyncResultMessage {
  if (typeof d.webError === 'string' && d.webError !== '') {
    return { kind: 'error', text: 'BFMR tracker-id backfill failed: ' + d.webError };
  }
  if (d.webRows === 0) {
    return { kind: 'error', text: 'BFMR tracker-id backfill failed: BFMR returned 0 tracker rows' };
  }
  let text =
    d.autoLinked && d.autoLinked > 0
      ? `Synced ${d.synced ?? 0}, auto-linked ${d.autoLinked} by order # / tracking`
      : `Synced ${d.synced ?? 0}`;
  const needed = d.webNeeded ?? 0;
  const backfilled = d.webBackfilled ?? 0;
  if (needed > 0 && backfilled < needed) {
    text += ` -- ${needed - backfilled} reservation(s) still lack a BFMR tracker id (unmatched ${d.webUnmatched ?? 0}, ambiguous ${d.webAmbiguous ?? 0})`;
  }
  return { kind: 'success', text };
}

/** Error shown when the link saved but the order-number push to BFMR did not. */
export function bfmrPushFailureMessage(reason: string | null | undefined): string {
  const r = reason ?? 'unknown reason';
  // The push gate's "reservation has no myTrackerId -- sync reservations from
  // BFMR first" is misleading: the REST sync never sets myTrackerId, only the
  // sidecar BFMR sync does.
  if (/myTrackerId|no BFMR tracker id/i.test(r)) {
    return 'Link saved, but the order number was NOT pushed to BFMR: this reservation has no BFMR tracker id yet -- run the sidecar BFMR sync (main-page sync), then try again';
  }
  return `Link saved, but the order number was NOT pushed to BFMR: ${r}`;
}
