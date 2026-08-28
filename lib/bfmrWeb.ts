import { getSetting, upsertSetting } from '@/lib/db';
import { loggedFetch } from '@/lib/apiCallLog';
import { type TrackerRow, buildOrderIdTrackerRow } from '@/lib/bfmrJoin';

// Re-exported so callers keep importing BFMR's Web-App surface from one
// place; the definitions live in bfmrJoin.ts because they are pure.
export { normalizeBfmrTimestamp, bfmrJoinKey, buildOrderIdTrackerRow } from '@/lib/bfmrJoin';
export type { TrackerRow } from '@/lib/bfmrJoin';

const BASE = 'https://www.bfmr.com/api';

// Session TTL: refresh 5 minutes before we expect it to expire.
// BFMR JWTs appear to be valid for ~60 minutes; we cache for 50.
const SESSION_TTL_MS = 50 * 60 * 1000;

type BfmrWebSession = { token: string; xsrf: string; cookieStr: string };

async function login(email: string, password: string): Promise<BfmrWebSession> {
  const res = await loggedFetch({ group: 'BFMR', userId: null }, `${BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ email, password, remember: false }),
  });
  if (!res.ok) throw new Error(`BFMR web login ${res.status}: ${await res.text()}`);
  const data = await res.json() as { access_token?: string; token?: string; data?: { access_token?: string; token?: string } };
  const payload = data.data ?? data;
  const token = payload.access_token ?? payload.token;
  if (!token) throw new Error(`BFMR web login: no token — data keys: ${Object.keys(data.data ?? data).join(', ')}`);

  const rawCookies: string[] = [];
  // Node 18+ fetch exposes getSetCookie(); fall back to parsing set-cookie header
  if (typeof (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === 'function') {
    rawCookies.push(...(res.headers as unknown as { getSetCookie: () => string[] }).getSetCookie());
  } else {
    const h = res.headers.get('set-cookie');
    if (h) rawCookies.push(...h.split(/,(?=[^ ])/));
  }

  const cookieStr = rawCookies.map(c => c.split(';')[0]).join('; ');
  const xsrfRaw = rawCookies.find(c => c.trimStart().startsWith('XSRF-TOKEN='));
  const xsrf = xsrfRaw ? decodeURIComponent(xsrfRaw.split('=').slice(1).join('=').split(';')[0]) : '';

  return { token, xsrf, cookieStr };
}

async function getSession(email: string, password: string, userId: number | null): Promise<BfmrWebSession> {
  const [tokenRow, xsrfRow, cookiesRow, expiresRow] = await Promise.all([
    getSetting(userId, 'bfmr_session_token'),
    getSetting(userId, 'bfmr_session_xsrf'),
    getSetting(userId, 'bfmr_session_cookies'),
    getSetting(userId, 'bfmr_session_expires'),
  ]);

  const token = tokenRow?.value;
  const xsrf = xsrfRow?.value ?? '';
  const cookieStr = cookiesRow?.value ?? '';
  const expires = expiresRow ? parseInt(expiresRow.value, 10) : 0;

  if (token && Date.now() < expires) {
    return { token, xsrf, cookieStr };
  }

  const session = await login(email, password);
  const expiresAt = Date.now() + SESSION_TTL_MS;

  await Promise.all([
    upsertSetting(userId, 'bfmr_session_token', session.token),
    upsertSetting(userId, 'bfmr_session_xsrf', session.xsrf),
    upsertSetting(userId, 'bfmr_session_cookies', session.cookieStr),
    upsertSetting(userId, 'bfmr_session_expires', String(expiresAt)),
  ]);

  return session;
}

function dateWindow(months = 3): { start: string; end: string } {
  const end = new Date();
  const start = new Date(end);
  start.setMonth(start.getMonth() - months);
  const fmt = (d: Date) => d.toISOString().split('T')[0];
  return { start: fmt(start), end: fmt(end) };
}

// Every status BFMR's Web App accepts in filter_status, same enum the REST
// sync uses. Only meaningful with filter_tab 'all' -- see fetchTrackerRows.
const ALL_WEB_STATUSES =
  'reserved,purchased,payment_error,return,shipped,processed,set_aside,paid,cancelled,returned,closed,deadline,pkg_received';

export type TrackerFetchOptions = {
  /** BFMR's own tab filter. 'action_needed' is only the awaiting-action subset. */
  tab?: string;
  /** How far back start_date reaches. 24 months makes BFMR 500 the request. */
  months?: number;
  statuses?: string;
};

async function fetchTrackerRows(session: BfmrWebSession, opts: TrackerFetchOptions = {}): Promise<TrackerRow[]> {
  // Defaults match BFMR's own UI request exactly (captured live via browser
  // API spy 2026-07-31) -- 'all' was never a value BFMR's own frontend sends
  // for the action-needed view, and silently returned nothing.
  //
  // But 'action_needed' is a genuinely narrow slice: measured live 2026-08-25
  // it returns 2 rows where filter_tab 'all' over the same window returns 453.
  // That is correct for tracking submission (only awaiting-action rows can
  // take a tracking number) and wrong for the myTrackerId backfill, which
  // needs every row BFMR knows about. Hence the option.
  const { start, end } = dateWindow(opts.months ?? 3);
  const out: TrackerRow[] = [];
  const pageSize = 500;

  for (let page = 1; page <= 10; page++) {
    const params = new URLSearchParams({
      page_size: String(pageSize), page_no: String(page), start_date: start, end_date: end,
      filter_tab: opts.tab ?? 'action_needed',
      filter_status: opts.statuses ?? 'reserved,purchased,payment_error,return',
    });

    const res = await loggedFetch({ group: 'BFMR', userId: null }, `${BASE}/my-tracker?${params}`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${session.token}`,
        Cookie: session.cookieStr,
      },
    });
    if (!res.ok) throw new Error(`BFMR fetch tracker ${res.status}`);
    const data = await res.json();
    // Real shape (captured live): { data: { my_tracker: [...] } } -- the rows
    // are nested under data.data.my_tracker, NOT data.data itself. The old
    // `data.data ?? data.tracker ?? data.my_tracker ?? ...` chain stopped at
    // `data.data` (a truthy object, not an array), so Array.isArray() always
    // failed and this silently returned [] on every single call -- this was
    // never actually about pagination, date windows, or filters.
    const rows = data.data?.my_tracker ?? data.my_tracker ?? data.data ?? data.tracker ?? data.items ?? data.results ?? [];
    if (!Array.isArray(rows)) break;
    out.push(...rows);
    if (rows.length < pageSize) break;
  }

  return out;
}

// Public wrapper for sync-reservations' myTrackerId backfill fallback: the
// REST surface (api.bfmr.com) never attaches my_tracker_id to ANY
// reservation (confirmed live 2026-08-25: 708/708 null, and a direct
// GET /api/bfmr/tracker shows the key is simply absent from the REST
// payload) -- exposing this lets the sync route cross-reference the two
// surfaces instead of leaving myTrackerId permanently null.
export async function getWebTrackerRows(
  email: string,
  password: string,
  userId: number | null = null,
  opts: TrackerFetchOptions = {},
): Promise<TrackerRow[]> {
  const session = await getSession(email, password, userId);
  return fetchTrackerRows(session, opts);
}

// The fetch the myTrackerId backfill wants: every row, widest window BFMR
// will actually serve. Measured live 2026-08-25 -- 12 months returns 453
// rows, 23 and 24 months both 500 on BFMR's side.
export const WEB_BACKFILL_FETCH: TrackerFetchOptions = { tab: 'all', months: 12, statuses: ALL_WEB_STATUSES };


export async function getProfile(email: string, password: string, userId: number | null = null): Promise<{ apiKey: string; apiSecret: string; extToken: string }> {
  const session = await getSession(email, password, userId);

  const [profileRes, extTokenRes] = await Promise.all([
    loggedFetch({ group: 'BFMR', userId }, `${BASE}/user/profile?_ts=${Date.now()}`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${session.token}`, Cookie: session.cookieStr },
    }),
    loggedFetch({ group: 'BFMR', userId }, `${BASE}/get-amazon-extensions-token?_ts=${Date.now()}`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${session.token}`, Cookie: session.cookieStr },
    }),
  ]);

  if (!profileRes.ok) throw new Error(`BFMR profile ${profileRes.status}`);
  const data = await profileRes.json();
  const user = data.data?.user ?? data.data ?? data.user ?? data;
  const apiAccess = user.api_access ?? user;
  const apiKey = apiAccess.api_key ?? apiAccess.apiKey;
  const apiSecret = apiAccess.api_secret ?? apiAccess.apiSecret;
  if (!apiKey || !apiSecret) throw new Error('BFMR profile: api_key/api_secret not found in response');

  let extToken = '';
  if (extTokenRes.ok) {
    const extData = await extTokenRes.json();
    extToken = extData.data?.token ?? '';
  }

  return { apiKey, apiSecret, extToken };
}

export type BfmrDeal = {
  id: number;
  title: string;
  slug: string;
  value: string;
  retail_type: string;
  retail_price: string | null;
  above_retail_amount: string | null;
  is_reservation_closed: number;
  other_retailers: number;
  status: string;
};

export async function getDeals(email: string, password: string, userId: number | null = null): Promise<BfmrDeal[]> {
  const session = await getSession(email, password, userId);
  const all: BfmrDeal[] = [];
  const perPage = 50;

  for (let page = 1; page <= 20; page++) {
    const params = new URLSearchParams({ source: 'deals', tag: 'all', page: String(page), per_page: String(perPage), _ts: String(Date.now()) });
    const res = await loggedFetch({ group: 'BFMR', userId }, `${BASE}/deals?${params}`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${session.token}`, Cookie: session.cookieStr },
    });
    if (!res.ok) throw new Error(`GET /api/deals page ${page}: ${res.status}`);
    const data = await res.json();
    const deals: BfmrDeal[] = data.data?.deals ?? data.deals ?? [];
    all.push(...deals);
    if (deals.length < perPage) break;
  }

  return all;
}

export type DealItemLink = {
  vendor_name: string;
  in_stock: boolean;
  link_url: string;
  identifier: string;
};

export type DealItem = {
  item_id: number;
  item_name?: string;
  max_can_reserve: number;
  is_reservation_closed: number;
  remaining_reservations: number;
  links?: DealItemLink[];
};

export async function getDealItems(email: string, password: string, dealSlug: string, userId: number | null = null): Promise<{ dealTitle: string; items: DealItem[] }> {
  const session = await getSession(email, password, userId);
  const res = await loggedFetch({ group: 'BFMR', userId }, `${BASE}/deals/${dealSlug}/items-reservations?isTracker=0&_ts=${Date.now()}`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${session.token}`, Cookie: session.cookieStr },
  });
  if (!res.ok) throw new Error(`items-reservations ${res.status}`);
  const data = await res.json();
  const deal = data.data?.deal;
  if (!deal) throw new Error('Deal not found');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const items: DealItem[] = (deal.items ?? []).map((item: any) => ({
    ...item,
    links: (item.links ?? []).map((l: any) => ({
      vendor_name: l.vendor?.name ?? '',
      in_stock: l.in_stock === true || l.in_stock === 1,
      link_url: l.item_link?.link_url ?? '',
      identifier: l.item_link?.identifier ?? '',
    })).filter((l: DealItemLink) => l.link_url),
  }));

  return { dealTitle: deal.title ?? dealSlug, items };
}

export async function checkAndReserve(
  email: string,
  password: string,
  dealSlug: string,
  itemId: number,
  qty: number,
  userId: number | null = null,
): Promise<{ reserved: boolean; available: boolean; qtyReserved: number }> {
  const session = await getSession(email, password, userId);

  const checkRes = await loggedFetch({ group: 'BFMR', userId }, `${BASE}/deals/${dealSlug}/items-reservations?isTracker=0&_ts=${Date.now()}`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${session.token}`, Cookie: session.cookieStr },
  });
  if (!checkRes.ok) throw new Error(`Availability check ${checkRes.status}`);
  const checkData = await checkRes.json();
  const items: DealItem[] = checkData.data?.deal?.items ?? [];
  const item = items.find(i => i.item_id === itemId);
  if (!item) throw new Error(`Item ${itemId} not found in deal ${dealSlug}`);

  if (item.is_reservation_closed === 1 || item.max_can_reserve <= 0) {
    return { reserved: false, available: false, qtyReserved: 0 };
  }

  const qtyToReserve = Math.min(qty, item.max_can_reserve);
  const body = new URLSearchParams();
  body.set('deal_slug', dealSlug);
  body.set('reservations[0][item_id]', String(itemId));
  body.set('reservations[0][item_qty]', String(qtyToReserve));

  const res = await loggedFetch({ group: 'BFMR', userId }, `${BASE}/deals/reserve`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      Authorization: `Bearer ${session.token}`,
      Cookie: session.cookieStr,
      ...(session.xsrf ? { 'X-XSRF-TOKEN': session.xsrf } : {}),
    },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`Reserve POST ${res.status}: ${await res.text()}`);

  return { reserved: true, available: true, qtyReserved: qtyToReserve };
}

// One submitted row, as actually accepted by BFMR — qty comes from BFMR's
// own tracker row (ground truth for how much that shipment covers), not
// from anything the caller guessed.
export type SubmittedTrackingRow = {
  orderId: string;
  myTrackerId: number;
  qty: number;
  trackingNumber: string;
};

// trackingMap: { [orderNumber]: trackingNumber | trackingNumber[] }
// Accepts a single string for backwards compatibility OR an array for
// split-shipment orders. When N tracking numbers are supplied for an order
// and BFMR exposes N rows with the same order_id (one per shipment), each
// row gets a different tracking number assigned in order. Rows that already
// have a tracking number set in BFMR are skipped.
export async function submitTracking(
  email: string,
  password: string,
  trackingMap: Record<string, string | string[]>,
  userId: number | null = null,
): Promise<SubmittedTrackingRow[]> {
  if (Object.keys(trackingMap).length === 0) return [];

  const session = await getSession(email, password, userId);
  const rows = await fetchTrackerRows(session);

  // Normalize the map values into mutable arrays we can pop from.
  const pendingPerOrder: Record<string, string[]> = {};
  for (const [orderId, val] of Object.entries(trackingMap)) {
    pendingPerOrder[orderId] = Array.isArray(val) ? [...val] : [val];
  }

  const toSubmit: TrackerRow[] = [];
  for (const row of rows) {
    if (!row.order_id) continue;
    const pending = pendingPerOrder[row.order_id];
    if (!pending || pending.length === 0) continue;
    if (row.tracking_number && row.tracking_number.trim()) continue; // already has tracking
    const next = pending.shift();
    if (!next) continue;
    toSubmit.push({ ...row, tracking_number: next });
  }

  if (toSubmit.length === 0) return [];

  const window = dateWindow();
  const res = await loggedFetch({ group: 'BFMR', userId }, `${BASE}/my-tracker`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${session.token}`,
      Cookie: session.cookieStr,
      ...(session.xsrf ? { 'X-XSRF-TOKEN': session.xsrf } : {}),
    },
    body: JSON.stringify({ tracker_data: toSubmit, dateRange: window }),
  });
  if (!res.ok) throw new Error(`BFMR submit tracking ${res.status}: ${await res.text()}`);

  return toSubmit.map(row => ({
    // Non-null by construction: rows without an order_id are skipped above.
    orderId: String(row.order_id),
    myTrackerId: row.my_tracker_id,
    qty: Number(row.qty) || 1,
    trackingNumber: row.tracking_number,
  }));
}

// Submit explicit (qty, tracking) rows for a single reservation. Unlike
// submitTracking() above — which fetches BFMR's current tracker rows and
// pops one tracking per existing row — this builds the tracker_data array
// directly from caller-supplied rows. Used by the per-order review UI so
// the user can split a multi-qty reservation across shipments before BFMR
// has split it server-side.
//
// Captured shape (per the 2026-06-28 spy of a qty=2 split-shipment submit):
//   { qty, id: PID, my_tracker_id, deal_id, item_id, type, status,
//     rowIndex, order_id, tracking_number }
//
// IMPORTANT (found live 2026-07-31): BFMR has two completely separate ID
// spaces for the same records. The api-key/api-secret REST API (used by
// sync-reservations to populate BfmrReservation.purchaseId/myTrackerId/
// dealId/itemId in our DB) returns opaque encrypted-string IDs. The
// session-cookie web API this function posts to expects BFMR's real
// internal *numeric* IDs — a genuinely different value, not just a
// different encoding of the same one. Passing our DB-stored IDs here
// silently submitted the wrong identifiers. Fixed by fetching fresh
// numeric tracker rows via the session (same as submitTracking() above)
// and matching by order_id, instead of trusting caller-supplied IDs at
// all — order_id is confirmed identical across both ID spaces.
export type ReservationSubmitRow = { qty: number; trackingNumber: string };

/**
 * Thrown when submitTrackingForReservation() fails BEFORE its POST
 * /my-tracker submission call is ever made (session lookup, tracker-row
 * fetch, or the my_tracker_id match). BFMR was never asked to record the
 * tracking number, so the failure is safe to retry blindly — unlike a
 * failure of the submission itself or of the post-submit verification,
 * where the request may have landed and a blind retry double-submits.
 * Callers use is() to pick the error's status/message apart from the
 * genuinely ambiguous 502 case.
 */
export class BfmrNotSubmittedError extends Error {
  static is(e: unknown): e is BfmrNotSubmittedError {
    return e instanceof BfmrNotSubmittedError;
  }
}

export async function submitTrackingForReservation(
  email: string,
  password: string,
  bfmrOrderId: string,
  myTrackerId: number,
  rows: ReservationSubmitRow[],
  userId: number | null = null,
): Promise<void> {
  if (rows.length === 0) return;

  // Everything up to and including the row lookup happens BEFORE the
  // POST /my-tracker submission call. If any of it fails, BFMR was never
  // asked to record this tracking number, so the failure is safe to retry
  // blindly. Re-throw it as BfmrNotSubmittedError so the caller can tell
  // it apart from a failure of the submission itself (or of the post-submit
  // verification below), where the request may have landed.
  let session: BfmrWebSession;
  let match: TrackerRow;
  try {
    session = await getSession(email, password, userId);
    const trackerRows = await fetchTrackerRows(session);
    // Match by my_tracker_id, NOT order_id -- a single BFMR order can be split
    // across multiple reservations sharing one bfmrOrderId (e.g. a 3-way split
    // shipment), and order_id alone can't tell them apart. Matching on the
    // shared order_id let one reservation's submission silently land on a
    // DIFFERENT reservation's tracker row instead: confirmed live on order 880
    // — BFMR's own portal showed "Enter tracking." for a reservation
    // resell-tracker believed was fully submitted, while a sibling reservation
    // under the same order ended up holding that tracking number instead.
    const found = trackerRows.find(r => r.my_tracker_id === myTrackerId);
    if (!found) {
      throw new Error(`No BFMR tracker row found for my_tracker_id ${myTrackerId} (order ${bfmrOrderId}) — sync reservations from BFMR first`);
    }
    match = found;
  } catch (e) {
    throw new BfmrNotSubmittedError(e instanceof Error ? e.message : String(e));
  }
  const window = dateWindow();

  const tracker_data = rows.map((r, idx) => ({
    qty: r.qty,
    id: match.PID ?? match.id,
    my_tracker_id: match.my_tracker_id,
    deal_id: match.deal_id,
    item_id: match.item_id,
    type: 'purchased',
    status: 'purchased',
    rowIndex: idx,
    order_id: match.order_id,
    tracking_number: r.trackingNumber,
  }));

  const res = await loggedFetch({ group: 'BFMR', userId }, `${BASE}/my-tracker`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${session.token}`,
      Cookie: session.cookieStr,
      ...(session.xsrf ? { 'X-XSRF-TOKEN': session.xsrf } : {}),
    },
    body: JSON.stringify({ tracker_data, dateRange: window }),
  });
  if (!res.ok) throw new Error(`BFMR submit reservation tracking ${res.status}: ${await res.text()}`);

  // Verify, don't just trust res.ok. A 200 here only means BFMR accepted the
  // request, not that this specific row ended up holding this tracking
  // number -- that gap is exactly how order 880's Space Gray reservation
  // got recorded locally as submitted while BFMR's own portal still showed
  // no tracking. Re-fetch and confirm the targeted row actually reflects
  // what was just sent before the caller commits to local success.
  const expected = rows[rows.length - 1]?.trackingNumber;
  const verifyRows = await fetchTrackerRows(session);
  const verifyMatch = verifyRows.find(r => r.my_tracker_id === myTrackerId);
  if (!verifyMatch || verifyMatch.tracking_number !== expected) {
    throw new Error(
      `BFMR accepted the submission but tracker row my_tracker_id=${myTrackerId} shows ` +
      `tracking_number=${verifyMatch?.tracking_number ?? '(row not found)'} afterward, ` +
      `not the expected ${expected} -- treating as failed rather than silently recording success.`,
    );
  }
}

/**
 * Push an order number onto a BFMR reservation — and, when the order covers
 * only part of it, split it in the same POST.
 *
 * Captured from BFMR's own "Multiple Order No." flow on 2026-08-25, because the
 * mechanism is not what it looks like. There is no split endpoint and no SID
 * manipulation: **reducing `qty` on the reservation row IS the split.** BFMR
 * splits off the assigned units, flips that row to `Purchased`, and creates the
 * remainder as a new reservation row on its own side, awaiting its own order
 * number. Posting the row's CURRENT qty just sets the order number. One shape
 * covers both, so there is one function.
 *
 * Observed request/response, verbatim:
 *   POST /my-tracker
 *   { tracker_data: [{ qty: 3, id: 1841666, RID: 1841666, PID: null, SID: null,
 *                      deal_id: 9645, item_id: 9042, my_tracker_id: 4901929,
 *                      type: "reservation", status: "reserved",
 *                      retail_price: 97, rowIndex: 0,
 *                      order_id: "111-4675771-1713018" }],
 *     dateRange: { start: "2026-05-25", end: "2026-08-25" } }
 *   -> 200 { success: true, message: "Data updated successfully!" }
 * A qty-5 reservation became a 3 (Purchased, with the order number) and a 2
 * (Reserved, blank order number).
 *
 * WHY THIS TAKES ONLY my_tracker_id: BFMR has two completely separate ID spaces
 * for the same records, and this endpoint speaks the numeric one. The REST API
 * that populates BfmrReservation returns opaque base64 for reserve_id /
 * purchase_id / deal_id / item_id, and never returns RID/PID/my_tracker_id at
 * all. The previous version of this code took our stored REST ids and did
 * `parseInt(reserveId, 10)` on them; measured live 2026-08-25 that is NaN on
 * 708/708 rows, and `JSON.stringify(NaN)` is `null`, so every identity in the
 * payload would have been null — and deal_id/item_id would have gone out as
 * base64 strings where BFMR wants 9645 and 9042. So: resolve the live Web row
 * by my_tracker_id (unique — verified across all 453 rows BFMR returns) and
 * take every numeric identity from BFMR's own current row, exactly as
 * submitTrackingForReservation already does.
 *
 * `tracking_number` is echoed back from that same live row rather than omitted:
 * the captured payload omits it, but only on a row whose tracking was blank, so
 * omission proves nothing about whether BFMR preserves or clears it. Echoing
 * BFMR's own current value is correct under either behaviour.
 *
 * IMPORTANT for the caller: after a SPLIT the LOCAL reservation record is
 * stale. BFMR now has two rows where we recorded one, and the remainder carries
 * a RID we have never seen. Linking the remaining units to a second order
 * requires a reservation re-sync first — there is no way to derive it from the
 * response, which returns no identifiers.
 */
export type OrderNumberPushResult = {
  /** The exact tracker_data[0] object sent (or that would be sent on a dry run). */
  payload: Record<string, unknown>;
  /** True when qty was reduced, i.e. BFMR split the reservation. */
  split: boolean;
  /** BFMR's current qty on that row, before this POST. */
  bfmrQty: number;
  dryRun: boolean;
};


export async function pushReservationOrderNumber(
  email: string,
  password: string,
  myTrackerId: number,
  qty: number,
  orderNumber: string,
  userId: number | null = null,
  opts: { dryRun?: boolean } = {},
): Promise<OrderNumberPushResult> {
  const session = await getSession(email, password, userId);
  // Look the row up in the widest view BFMR serves, not just action_needed —
  // this must not fail merely because the row sits in a tab we didn't ask for.
  const rows = await fetchTrackerRows(session, WEB_BACKFILL_FETCH);
  const matches = rows.filter(r => Number(r.my_tracker_id) === Number(myTrackerId));
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly 1 BFMR tracker row for my_tracker_id ${myTrackerId}, found ${matches.length} ` +
      `— refusing to push order number ${orderNumber}. Re-sync reservations from BFMR first.`,
    );
  }
  const match = matches[0];

  const bfmrQty = parseInt(String(match.qty ?? '0'), 10) || 0;
  if (qty > bfmrQty) {
    throw new Error(
      `Refusing to push order number ${orderNumber}: qty ${qty} exceeds BFMR's current qty ${bfmrQty} ` +
      `on my_tracker_id ${myTrackerId}. Increasing qty is not a split and would not mean what it looks like.`,
    );
  }

  const trackerRow = buildOrderIdTrackerRow(match, qty, orderNumber);
  const result: OrderNumberPushResult = {
    payload: trackerRow,
    split: qty < bfmrQty,
    bfmrQty,
    dryRun: opts.dryRun === true,
  };
  if (opts.dryRun) return result;

  const window = dateWindow();
  const res = await loggedFetch({ group: 'BFMR', userId }, `${BASE}/my-tracker`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${session.token}`,
      Cookie: session.cookieStr,
      ...(session.xsrf ? { 'X-XSRF-TOKEN': session.xsrf } : {}),
    },
    body: JSON.stringify({ tracker_data: [trackerRow], dateRange: window }),
  });
  if (!res.ok) throw new Error(`BFMR push order_id ${res.status}: ${await res.text()}`);

  return result;
}

export async function cancelReservation(
  email: string,
  password: string,
  trackerRow: Record<string, unknown>,
  userId: number | null = null,
): Promise<void> {
  const session = await getSession(email, password, userId);
  const res = await loggedFetch({ group: 'BFMR', userId }, `${BASE}/my-tracker/action`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${session.token}`,
      Cookie: session.cookieStr,
      ...(session.xsrf ? { 'X-XSRF-TOKEN': session.xsrf } : {}),
    },
    body: JSON.stringify({ action: 'cancel', tracker_data: [trackerRow] }),
  });
  if (!res.ok) throw new Error(`BFMR cancel reservation ${res.status}: ${await res.text()}`);
}
