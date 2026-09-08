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
 *   - 'pending'   the row exists but its tracking_number is still empty --
 *                 read-after-write lag (the live 502 on my_tracker_id=4939069:
 *                 BFMR accepted TBA334421203888, the row was already in a
 *                 shipped-type status so it was NOT 'not-found', but its
 *                 tracking_number had not propagated yet). Retryable; only a
 *                 failure if it is STILL empty after all attempts.
 *   - 'mismatch'  the row exists and holds a DIFFERENT non-empty tracking
 *                 number -- the order-880 guard; must fail closed, never be
 *                 retried into success
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
): 'ok' | 'pending' | 'mismatch' | 'not-found' {
  const match = verifyRows.find(r => r.my_tracker_id === myTrackerId);
  if (!match) return 'not-found';
  // Normalize both sides (BFMR may pad; the submit route already trims its
  // input, but trim defensively on read-back too).
  const actual = (match.tracking_number ?? '').trim();
  if (actual === '') return 'pending';
  return actual === expected.trim() ? 'ok' : 'mismatch';
}

function realSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Orchestrates the post-submit verification fetch + classify loop. Still pure
 * of DB/session/network on purpose: the row fetcher (and the sleep between
 * retries) are injected, so tests can assert EXACTLY what breadth the verify
 * re-fetch runs at and that a mismatch is never retried -- without a live
 * BFMR session.
 *
 * The breadth guard lives HERE, in one place: every attempt calls
 * `fetchRows(WEB_BACKFILL_FETCH)`, so a test's spy fetcher can assert it was
 * called with WEB_BACKFILL_FETCH and go RED if the verify path ever reverts to
 * fetchTrackerRows' default filter (the live 502 on my_tracker_id=4932432).
 *
 * Retry policy: 'not-found' AND 'pending' (row present but tracking_number
 * still empty) are retried, up to `attempts` times (default 3) with `delayMs`
 * (default 500) between attempts -- a bounded self-heal for genuine
 * read-after-write lag. Both shapes were observed live: the row can be absent
 * from the fetch entirely, or present in its post-submit status while its
 * tracking_number has not propagated yet (my_tracker_id=4939069). 'ok' and
 * 'mismatch' return immediately; a mismatch must fail closed on the first
 * sight of it, never be retried into success (the order-880 guard). `actual`
 * is the matched row's tracking_number from the LAST fetch (null when not
 * found) so callers keep their exact error message.
 */
export async function verifySubmission(
  fetchRows: (opts: TrackerFetchOptions) => Promise<{ my_tracker_id: number; tracking_number: string | null }[]>,
  myTrackerId: number,
  expected: string,
  opts: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ verdict: 'ok' | 'pending' | 'mismatch' | 'not-found'; actual: string | null }> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const delayMs = opts.delayMs ?? 500;
  const sleep = opts.sleep ?? realSleep;

  let rows: { my_tracker_id: number; tracking_number: string | null }[] = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    // Breadth enforced here, in one place -- never the default filter.
    rows = await fetchRows(WEB_BACKFILL_FETCH);
    const verdict = classifyVerify(rows, myTrackerId, expected);
    if (verdict === 'ok' || verdict === 'mismatch') {
      return { verdict, actual: rows.find(r => r.my_tracker_id === myTrackerId)?.tracking_number ?? null };
    }
    // 'not-found' and 'pending' are both read-after-write lag; retry.
    if (attempt < attempts) await sleep(delayMs);
  }
  // Exhausted retries on not-found/pending; report the last classification so
  // the caller's error message distinguishes "row absent" from "row present,
  // number still empty".
  const verdict = classifyVerify(rows, myTrackerId, expected);
  return { verdict, actual: rows.find(r => r.my_tracker_id === myTrackerId)?.tracking_number ?? null };
}
