const BASE = 'https://api.prod.buyinggroup.com/v1';

export type BuyingGroupCredentials = {
  email: string;
  password: string;
};

// BuyingGroup stores access token as "auth_token" in localStorage.
// Login response uses auth_token/refresh_token; simplejwt refresh response uses access.
export type BuyingGroupTokens = {
  auth_token?: string;
  access?: string;
  refresh_token?: string;
  refresh?: string;
};

export function extractTokens(raw: BuyingGroupTokens): { access: string; refresh: string } {
  // Login response: { token: { access, refresh } }
  const nested = (raw as Record<string, unknown>).token as BuyingGroupTokens | undefined;
  const access = nested?.access ?? nested?.auth_token ?? raw.auth_token ?? raw.access ?? '';
  const refresh = nested?.refresh ?? nested?.refresh_token ?? raw.refresh_token ?? raw.refresh ?? '';
  return { access, refresh };
}

export type BGReceipt = {
  id: number;
  order_number: string;
  store_name: string;
  status: string;
  total_amount: string;
  cashback_amount: string;
  created_at: string;
  updated_at: string;
  tracking_number?: string;
  tracking_url?: string;
  payment_date?: string;
  [key: string]: unknown;
};

export type BGDealItemStore = {
  store_slug: string;
  store_name: string;
  store_icon_new?: string;
  link?: string;
  [key: string]: unknown;
};

export type BGDealItem = {
  key?: string;
  item_stores?: BGDealItemStore[];
  [key: string]: unknown;
};

export type BGDealFlag = {
  slug: string;
  name: string;
  active: boolean;
};

export type BGDeal = {
  key: string;
  deal_id: string;
  title: string;
  image_new?: string;
  active: boolean;
  price: string;          // what you pay at the store
  commission: string;     // what BG pays you
  old_price?: string | null;
  commit_required: boolean;
  commit_locked: boolean;
  is_special: boolean;
  expiry_day?: string;    // MM-DD-YYYY
  flags?: BGDealFlag[];
  deal_item?: BGDealItem[];
  [key: string]: unknown;
};

export type BGCommitmentItem = {
  key: string;
  item_title: string;
  item_model: string;
  item_id: string;
  item_image_new?: string;
  upc?: string;
  limit_total: number | null;
  limit_user: number | null;
  enabled: boolean;
  in_stock: boolean;
  commission: string;
  current_cost: string;
  total: string;
  bg_points_reward: number;
  commitment_count: number | null;
  commitment_percentage: number | null;
};

export type BGCommitment = {
  key: string;
  commitment_id: string;                                    // e.g. "CM-264497594"
  deal: { key: string; title: string; deal_id: string };
  deal_id: string;                                          // e.g. "DL-06260061"
  item: { key: string; item_id: string; image_new?: string; image?: string | null };
  deal_status: boolean;
  status: string;                                           // "ACTIVE", etc.
  count: number;                                            // committed quantity
  fulfilled: number;                                        // delivered quantity per BG
  expiry_day: string;                                       // "MM-DD-YYYY"
  price: string;                                            // numeric string
  commission: string;                                       // numeric string
  total: string;                                            // numeric string
  bg_points_reward: number;
  created_dt: string;                                       // "MM-DD-YYYY, HH:MM:SS"
  editable: boolean;
  tracking_linked_required: boolean;
  [key: string]: unknown;
};

async function bgFetch(path: string, token: string, options?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`BuyingGroup API ${res.status}: ${body}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Auth — Django simplejwt pattern
// ---------------------------------------------------------------------------

const AUTH_BASE = 'https://api.prod.buyinggroup.com/v2';
const LOGIN_ENDPOINT = '/token/get';
const REFRESH_ENDPOINT = '/token/refresh';

export async function login(creds: BuyingGroupCredentials): Promise<{ access: string; refresh: string }> {
  const res = await fetch(`${AUTH_BASE}${LOGIN_ENDPOINT}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: creds.email, password: creds.password }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`BuyingGroup login failed (${res.status}): ${body}`);
  }
  const raw: BuyingGroupTokens = await res.json();
  return extractTokens(raw);
}

export async function refreshAccessToken(refresh: string): Promise<string> {
  const res = await fetch(`${AUTH_BASE}${REFRESH_ENDPOINT}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh }),
  });
  if (!res.ok) throw new Error('BuyingGroup token refresh failed');
  const raw: BuyingGroupTokens = await res.json();
  return extractTokens(raw).access;
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

export type BGPayment = {
  key: string;
  payment_id: string;
  amount: string;
  type: string;
  status: string; // "PAID", "REQUESTED", "SENT"
  paid_dt: string | null;
  processed_dt: string | null;
  created_dt: string;
  [key: string]: unknown;
};

export async function getPayments(token: string): Promise<BGPayment[]> {
  const data = await bgFetch('/payment/get_payments', token, { method: 'POST', body: '{}' }) as Record<string, unknown>;
  const payload = data.payload as Record<string, unknown> | undefined;
  return (payload?.payments ?? []) as BGPayment[];
}

// ---------------------------------------------------------------------------
// Receipts / Tracker
// ---------------------------------------------------------------------------

export async function getReceipts(
  token: string,
  page = 1,
  pageSize = 50,
): Promise<{ results: BGReceipt[]; count: number }> {
  return bgFetch('/receipt/get_receipts', token, {
    method: 'POST',
    body: JSON.stringify({ page, page_size: pageSize }),
  });
}

export async function getReceiptDetails(token: string, receiptId: number): Promise<BGReceipt> {
  return bgFetch('/receipt/get_details', token, {
    method: 'POST',
    body: JSON.stringify({ receipt_id: receiptId }),
  });
}

// ---------------------------------------------------------------------------
// Orders (includes unprocessed/processing/shipped before receipt is created)
// ---------------------------------------------------------------------------

export type BGOrder = {
  id: number;
  order_number?: string;
  status: string;
  tracking_number?: string;
  tracking_url?: string;
  store_name?: string;
  total_amount?: string;
  created_at?: string;
  [key: string]: unknown;
};

export async function getOrders(
  token: string,
  page = 1,
  pageSize = 50,
): Promise<{ results: BGOrder[]; count: number }> {
  return bgFetch('/order/get_orders', token, {
    method: 'POST',
    body: JSON.stringify({ page, page_size: pageSize }),
  });
}

// ---------------------------------------------------------------------------
// Submit tracking
// ---------------------------------------------------------------------------

export async function submitTracking(token: string, trackingNumbers: string[]): Promise<unknown> {
  const form = new FormData();
  form.append('tracking_list', JSON.stringify(trackingNumbers));
  const res = await fetch(`${BASE}/order/add_trackings`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`BuyingGroup submit tracking ${res.status}: ${body}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Deals
// ---------------------------------------------------------------------------

export async function getDeals(
  token: string,
  params: {
    page?: number;
    pageSize?: number;
    dataType?: 'on_sale_now' | 'below_cost' | 'all' | 'active';
    title?: string;
  } = {},
): Promise<{ results: BGDeal[]; count: number }> {
  const { page = 1, pageSize = 60, dataType = 'active', title = '' } = params;
  const qs = new URLSearchParams({
    page: String(page),
    page_size: String(pageSize),
    data_type: dataType,
    buyer_view: 'true',
    is_full: 'null',
    is_locked: 'null',
    title,
  });
  const raw = await bgFetch(`/deal/get_deals_new?${qs}`, token) as Record<string, unknown>;
  const payload = (raw.payload ?? raw) as Record<string, unknown>;
  // BG API returns deals in payload.deals (not payload.results)
  const results = (Array.isArray(payload.deals) ? payload.deals : []) as BGDeal[];
  const count = (typeof payload.count === 'number' ? payload.count : results.length);
  return { results, count };
}

// ---------------------------------------------------------------------------
// Dashboard stats
// ---------------------------------------------------------------------------

export async function getStatistics(token: string): Promise<Record<string, unknown>> {
  return bgFetch('/dashboard/get_statistics', token, { method: 'POST', body: '{}' });
}

export async function getBalance(token: string): Promise<{ remaining_balance: number }> {
  const data = await bgFetch('/dashboard/get_statistics', token, { method: 'POST', body: '{}' }) as Record<string, unknown>;
  const payload = (data?.payload as Record<string, unknown> | undefined);
  const balance = payload?.balance as Record<string, unknown> | undefined;
  return { remaining_balance: parseFloat(String(balance?.remaining_balance ?? 0)) || 0 };
}

// ---------------------------------------------------------------------------
// Commitments
// ---------------------------------------------------------------------------

type BgPayload<T> = { payload: T };

export async function getCommitmentItems(token: string, dealKey: string): Promise<BGCommitmentItem[]> {
  const data = await bgFetch('/commitment/get_commitment_items', token, {
    method: 'POST',
    body: JSON.stringify({ deal_key: dealKey }),
  }) as BgPayload<{ commitment_items: BGCommitmentItem[] }>;
  return data.payload?.commitment_items ?? [];
}

export async function saveCommitment(token: string, dealKey: string, itemKey: string): Promise<unknown> {
  return bgFetch('/commitment/save_commitment', token, {
    method: 'POST',
    body: JSON.stringify({ deal_key: dealKey, item_key: itemKey }),
  });
}

export async function editCommitment(token: string, dealKey: string, itemKey: string, quantity: number): Promise<unknown> {
  return bgFetch('/commitment/edit_commitment', token, {
    method: 'POST',
    body: JSON.stringify({ deal_key: dealKey, item_key: itemKey, quantity }),
  });
}

export async function getCommitments(token: string, page = 1, pageSize = 100): Promise<{ commitments: BGCommitment[]; count: number }> {
  const data = await bgFetch('/commitment/get_commitments', token, {
    method: 'POST',
    body: JSON.stringify({ page, page_size: pageSize }),
  }) as BgPayload<{ commitments: BGCommitment[]; count: number }>;
  return { commitments: data.payload?.commitments ?? [], count: data.payload?.count ?? 0 };
}
