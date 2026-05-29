const BASE = 'https://api.bfmr.com/api/v2';

export type BfmrOrder = {
  orderId: string;
  status: string;
  trackingNumber?: string;
  carrier?: string;
  paymentAmount?: number;
  paymentStatus?: string;
  createdAt?: string;
};

export type BfmrPayment = {
  paymentId: string;
  amount: number;
  status: string;
  issuedAt?: string;
};

async function bfmrFetch(path: string, apiKey: string, options?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(options?.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`BFMR ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function testConnection(apiKey: string): Promise<boolean> {
  try {
    await bfmrFetch('/deals', apiKey);
    return true;
  } catch {
    return false;
  }
}

export async function getDeals(apiKey: string): Promise<BfmrOrder[]> {
  return bfmrFetch('/deals', apiKey);
}

export async function getDeal(apiKey: string, dealId: string): Promise<BfmrOrder> {
  return bfmrFetch(`/deals/${dealId}`, apiKey);
}

// TODO: confirm payment endpoint path from API spec
export async function getPayments(apiKey: string): Promise<BfmrPayment[]> {
  return bfmrFetch('/payments', apiKey);
}
