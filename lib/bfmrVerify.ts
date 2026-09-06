// Pure logic for BFMR post-submit verification: which fetch breadth the
// verify re-fetch must use, and how to classify what it comes back with.
// No imports on purpose -- same rule as bfmrJoin.ts: this is the part that
// has to be exercisable without dragging in the DB, the session cache, or
// fetch (bfmrWeb.ts's '@/lib/db' alias import cannot resolve under plain
// node --experimental-strip-types).

/** Every status BFMR's Web App accepts in filter_status, same enum the REST
 * sync uses. Only meaningful with filter_tab 'all'. */
export const ALL_WEB_STATUSES =
  'reserved,purchased,payment_error,return,shipped,processed,set_aside,paid,cancelled,returned,closed,deadline,pkg_received';

export type TrackerFetchOptions = {
  /** BFMR's own tab filter. 'action_needed' is only the awaiting-action subset. */
  tab?: string;
  /** How far back start_date reaches. 24 months makes BFMR 500 the request. */
  months?: number;
  statuses?: string;
};

// The fetch the myTrackerId backfill wants: every row, widest window BFMR
// will actually serve. Measured live 2026-08-25 -- 12 months returns 453
// rows, 23 and 24 months both 500 on BFMR's side.
//
// This is ALSO the breadth submitTrackingForReservation()'s post-submit
// verification must use: submitting a tracking number transitions the row
// OUT of fetchTrackerRows' default filter (filter_tab 'action_needed',
// filter_status 'reserved,purchased,payment_error,return') into a shipped-
// type status that only this all-status list covers. Re-fetching with the
// defaults after a successful submit therefore legitimately returns no row
// for my_tracker_id -- "row not found" on a submission BFMR accepted (the
// live 502 on my_tracker_id=4932432). The default filter stays correct for
// the pre-submit lookup, where only awaiting-action rows can take tracking.
export const WEB_BACKFILL_FETCH: TrackerFetchOptions = { tab: 'all', months: 12, statuses: ALL_WEB_STATUSES };

/**
 * Classify the post-submit read-back of one tracker row. Pure on purpose so
 * the decision is testable without a live BFMR session:
 *   - 'ok'        the targeted row exists and carries exactly `expected`
 *   - 'mismatch'  the row exists but holds a different tracking number --
 *                 the order-880 guard; must fail closed, never be retried
 *                 into success
 *   - 'not-found' no row for myTrackerId in what the fetch returned
 * Status is deliberately NOT an input: after submit the row has moved to a
 * shipped-type status, and matching on id + tracking number is all that
 * matters. Callers are responsible for fetching at WEB_BACKFILL_FETCH
 * breadth so 'not-found' means genuinely absent, not filtered out.
 */
export function classifyVerify(
  verifyRows: { my_tracker_id: number; tracking_number: string | null }[],
  myTrackerId: number,
  expected: string,
): 'ok' | 'mismatch' | 'not-found' {
  const match = verifyRows.find(r => r.my_tracker_id === myTrackerId);
  if (!match) return 'not-found';
  return match.tracking_number === expected ? 'ok' : 'mismatch';
}
