const BASE = 'https://api.bfmr.com';

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
    await bfmrFetch('/orders', apiKey);
    return true;
  } catch {
    return false;
  }
}

export async function getOrders(apiKey: string): Promise<BfmrOrder[]> {
  return bfmrFetch('/orders', apiKey);
}

export async function getOrder(apiKey: string, orderId: string): Promise<BfmrOrder> {
  return bfmrFetch(`/orders/${orderId}`, apiKey);
}

export async function getPayments(apiKey: string): Promise<BfmrPayment[]> {
  return bfmrFetch('/payments', apiKey);
}
