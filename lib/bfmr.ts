const BASE = 'https://api.bfmr.com/api/v2';

export type BfmrCredentials = { apiKey: string; apiSecret: string };

export type TrackerItem = {
  reserve_id?: string;
  purchase_id?: string;
  shipment_id?: string;
  order_no?: string;
  tracking_number?: string;
  status: string;
  qty?: number;
  qty_received?: number;
  retail_price?: number;
  sub_total?: number;
  amount_paid?: number;
  reserved_at?: string;
  date_processed?: string;
  date_paid?: string;
  insurance_status?: string;
  [key: string]: unknown;
};

export type Deal = {
  deal_id: string;
  deal_code: string;
  retail_price: number;
  title: string;
  slug: string;
  closing_at: string;
  is_reservation_closed: boolean;
  retailers: string;
  retail_type: string;
  payout_price: number;
  deal_information: string;
  is_bundle: boolean;
  is_exclusive_deal: boolean;
  items: unknown[];
};

export type InsuredShipment = {
  shipment: Record<string, unknown>;
};

async function bfmrFetch(path: string, creds: BfmrCredentials, options?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      'API-KEY': creds.apiKey,
      'API-SECRET': creds.apiSecret,
      'Content-Type': 'application/json',
      ...(options?.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`BFMR ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function testConnection(creds: BfmrCredentials): Promise<boolean> {
  try {
    await bfmrFetch('/deals?page_size=1', creds);
    return true;
  } catch {
    return false;
  }
}

// My Tracker
export type TrackerFilter = {
  page_size?: number;
  page_no?: number;
  quick_filter?: 'all' | 'pending' | 'action_needed' | 'paid' | 'closed';
  status?: string;
  search?: string;
  start_date?: string;
  end_date?: string;
  order_by?: string;
  order?: 'asc' | 'desc';
  insurance_status?: string;
};

export async function getMyTracker(creds: BfmrCredentials, filters: TrackerFilter = {}): Promise<TrackerItem[]> {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([k, v]) => { if (v != null) params.set(k, String(v)); });
  const qs = params.toString() ? `?${params}` : '';
  const data = await bfmrFetch(`/my-tracker${qs}`, creds);
  return data.my_tracker ?? [];
}

export async function updateTracker(creds: BfmrCredentials, trackerData: object[]): Promise<unknown> {
  return bfmrFetch('/my-tracker', creds, {
    method: 'POST',
    body: JSON.stringify({ tracker_data: trackerData }),
  });
}

// Deals
export async function getDeals(creds: BfmrCredentials, params?: {
  page_size?: number; page_no?: number; retailer?: string;
  retail_type?: string; exclusive_deals_only?: '0' | '1'; in_stock?: '0' | '1';
}): Promise<Deal[]> {
  const qs = params ? `?${new URLSearchParams(Object.entries(params ?? {}).map(([k, v]) => [k, String(v)]))}` : '';
  const data = await bfmrFetch(`/deals${qs}`, creds);
  const deals = data.deals;
  return Array.isArray(deals) ? deals : deals ? [deals] : [];
}

export async function getDeal(creds: BfmrCredentials, slug: string): Promise<Deal> {
  const data = await bfmrFetch(`/deals/${slug}`, creds);
  return data.deal;
}

export async function getActiveReservations(creds: BfmrCredentials): Promise<unknown[]> {
  const data = await bfmrFetch('/deal/reservations/active', creds);
  return data.reservation_list ?? [];
}

// Shipments
export async function getShipmentStatus(creds: BfmrCredentials, trackingNumber: string): Promise<unknown[]> {
  const data = await bfmrFetch(`/shipments/status?tracking_number=${encodeURIComponent(trackingNumber)}`, creds);
  return data.tracker_data ?? [];
}

// Insurance
export async function getInsuredShipments(creds: BfmrCredentials, params?: {
  page?: number; per_page?: number; tracking_numbers?: string;
}): Promise<{ shipments: unknown[]; paging: unknown }> {
  const qs = params ? `?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))}` : '';
  const data = await bfmrFetch(`/insurance/shipments${qs}`, creds);
  return { shipments: data.insurance?.shipments ?? [], paging: data.paging };
}

export async function fileInsurance(creds: BfmrCredentials, trackingNumber: string, packageValue?: number): Promise<string> {
  const body = new URLSearchParams({ tracking_number: trackingNumber });
  if (packageValue != null) body.set('package_value', String(packageValue));
  const data = await bfmrFetch('/insurance/file', creds, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  return data.message;
}

// Look-ups
export async function getRetailers(creds: BfmrCredentials): Promise<unknown[]> {
  const data = await bfmrFetch('/look-ups/retailers?page_size=1000', creds);
  const retailers = data.retailers;
  return Array.isArray(retailers) ? retailers : retailers ? [retailers] : [];
}
