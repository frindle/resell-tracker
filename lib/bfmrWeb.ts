const BASE = 'https://www.bfmr.com/api';

type BfmrWebSession = { token: string; xsrf: string; cookieStr: string };

async function login(email: string, password: string): Promise<BfmrWebSession> {
  const res = await fetch(`${BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`BFMR web login ${res.status}: ${await res.text()}`);
  const data = await res.json() as { access_token?: string; token?: string };
  const token = data.access_token ?? data.token;
  if (!token) throw new Error('BFMR web login: no token in response');

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

export async function getProfile(email: string, password: string): Promise<{ apiKey: string; apiSecret: string }> {
  const session = await login(email, password);
  const res = await fetch(`${BASE}/profile`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${session.token}`,
      Cookie: session.cookieStr,
    },
  });
  if (!res.ok) throw new Error(`BFMR profile ${res.status}`);
  const data = await res.json();
  // Profile shape: { data: { api_key, api_secret } } or { api_key, api_secret } directly
  const profile = data.data ?? data.user ?? data.profile ?? data;
  const apiKey = profile.api_key ?? profile.apiKey;
  const apiSecret = profile.api_secret ?? profile.apiSecret;
  if (!apiKey || !apiSecret) throw new Error('BFMR profile: api_key/api_secret not found in response');
  return { apiKey, apiSecret };
}

// trackingMap: { [orderNumber]: trackingNumber }
export async function submitTracking(
  email: string,
  password: string,
  trackingMap: Record<string, string>,
): Promise<void> {
  if (Object.keys(trackingMap).length === 0) return;

  const session = await login(email, password);
  const rows = await fetchTrackerRows(session);

  const toSubmit: TrackerRow[] = [];
  for (const row of rows) {
    if (!row.order_id) continue;
    const incoming = trackingMap[row.order_id];
    if (!incoming) continue;
    if (row.tracking_number && row.tracking_number.trim()) continue; // already has tracking
    toSubmit.push({ ...row, tracking_number: incoming });
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
