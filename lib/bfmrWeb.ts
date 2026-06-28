import { getSetting, upsertSetting } from '@/lib/db';

const BASE = 'https://www.bfmr.com/api';

// Session TTL: refresh 5 minutes before we expect it to expire.
// BFMR JWTs appear to be valid for ~60 minutes; we cache for 50.
const SESSION_TTL_MS = 50 * 60 * 1000;

type BfmrWebSession = { token: string; xsrf: string; cookieStr: string };

async function login(email: string, password: string): Promise<BfmrWebSession> {
  const res = await fetch(`${BASE}/login`, {
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

type TrackerRow = {
  id: number;
  PID: number;
  RID?: number;
  SID?: number | null;
  type: string;
  force_delete_shipment_after_deadline?: number;
  item_id: number;
  qty: string;
  my_tracker_id: number;
  notes: string;
  order_id: string;
  tracking_number: string;
  deal_id: number;
  has_custom_columns: number;
  is_bundle: number;
  amount_paid: string;
  paid_at: string;
  qty_received: string;
  reserved_at: string;
  retail_price: number;
  scanned_at: string;
  status: string;
  sub_total: number;
  [key: string]: unknown;
};

function dateWindow(): { start: string; end: string } {
  const end = new Date();
  const start = new Date(end);
  start.setMonth(start.getMonth() - 3);
  const fmt = (d: Date) => d.toISOString().split('T')[0];
  return { start: fmt(start), end: fmt(end) };
}

async function fetchTrackerRows(session: BfmrWebSession): Promise<TrackerRow[]> {
  const { start, end } = dateWindow();
  const params = new URLSearchParams({ page_size: '500', page_no: '1', start_date: start, end_date: end, filter_tab: 'all' });

  const res = await fetch(`${BASE}/my-tracker?${params}`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${session.token}`,
      Cookie: session.cookieStr,
    },
  });
  if (!res.ok) throw new Error(`BFMR fetch tracker ${res.status}`);
  const data = await res.json();
  const rows = data.data ?? data.tracker ?? data.my_tracker ?? data.items ?? data.results ?? [];
  return Array.isArray(rows) ? rows : [];
}

export async function getProfile(email: string, password: string, userId: number | null = null): Promise<{ apiKey: string; apiSecret: string; extToken: string }> {
  const session = await getSession(email, password, userId);

  const [profileRes, extTokenRes] = await Promise.all([
    fetch(`${BASE}/user/profile?_ts=${Date.now()}`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${session.token}`, Cookie: session.cookieStr },
    }),
    fetch(`${BASE}/get-amazon-extensions-token?_ts=${Date.now()}`, {
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
    const res = await fetch(`${BASE}/deals?${params}`, {
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
  const res = await fetch(`${BASE}/deals/${dealSlug}/items-reservations?isTracker=0&_ts=${Date.now()}`, {
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

  const checkRes = await fetch(`${BASE}/deals/${dealSlug}/items-reservations?isTracker=0&_ts=${Date.now()}`, {
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

  const res = await fetch(`${BASE}/deals/reserve`, {
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
): Promise<void> {
  if (Object.keys(trackingMap).length === 0) return;

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

  if (toSubmit.length === 0) return;

  const window = dateWindow();
  const res = await fetch(`${BASE}/my-tracker`, {
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
export type ReservationSubmitInput = {
  purchaseId: number;       // BFMR PID
  myTrackerId: number;
  dealId: number;
  itemId: number;
  bfmrOrderId: string;
};
export type ReservationSubmitRow = { qty: number; trackingNumber: string };

export async function submitTrackingForReservation(
  email: string,
  password: string,
  reservation: ReservationSubmitInput,
  rows: ReservationSubmitRow[],
  userId: number | null = null,
): Promise<void> {
  if (rows.length === 0) return;

  const session = await getSession(email, password, userId);
  const window = dateWindow();

  const tracker_data = rows.map((r, idx) => ({
    qty: r.qty,
    id: reservation.purchaseId,
    my_tracker_id: reservation.myTrackerId,
    deal_id: reservation.dealId,
    item_id: reservation.itemId,
    type: 'purchased',
    status: 'purchased',
    rowIndex: idx,
    order_id: reservation.bfmrOrderId,
    tracking_number: r.trackingNumber,
  }));

  const res = await fetch(`${BASE}/my-tracker`, {
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
}

export async function cancelReservation(
  email: string,
  password: string,
  trackerRow: Record<string, unknown>,
  userId: number | null = null,
): Promise<void> {
  const session = await getSession(email, password, userId);
  const res = await fetch(`${BASE}/my-tracker/action`, {
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
