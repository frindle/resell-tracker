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
  const access = raw.auth_token ?? raw.access ?? '';
  const refresh = raw.refresh_token ?? raw.refresh ?? '';
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

export type BGDeal = {
  id: number;
  title: string;
  store_name: string;
  retail_price: string;
  cashback_amount: string;
  quantity_available: number;
  expires_at: string;
  is_exclusive: boolean;
  is_bundle: boolean;
  status: string;
  url?: string;
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
    body: JSON.stringify({ email: creds.email, password: creds.password }),
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
// Deals
// ---------------------------------------------------------------------------

export async function getDeals(
  token: string,
  params: {
    page?: number;
    pageSize?: number;
    dataType?: 'on_sale_now' | 'below_cost' | 'all';
    title?: string;
  } = {},
): Promise<{ results: BGDeal[]; count: number }> {
  const { page = 1, pageSize = 60, dataType = 'on_sale_now', title = '' } = params;
  const qs = new URLSearchParams({
    page: String(page),
    page_size: String(pageSize),
    data_type: dataType,
    buyer_view: 'true',
    is_full: 'null',
    is_locked: 'null',
    title,
  });
  return bgFetch(`/deal/get_deals_new?${qs}`, token);
}

// ---------------------------------------------------------------------------
// Dashboard stats
// ---------------------------------------------------------------------------

export async function getStatistics(token: string): Promise<Record<string, unknown>> {
  return bgFetch('/dashboard/get_statistics', token, { method: 'POST', body: '{}' });
}
