import { prisma, getSetting } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { getCcToken } from '@/lib/cardcenter';

const BASE_URL = 'https://cardcenter.cc';

const STATUS_SEGMENT: Record<string, string> = {
  Waiting: 'Scheduled',
  Sent: 'Sent',
  Completed: 'Completed',
};

const API_STATUS_MAP: Record<string, string> = {
  Waiting: 'Scheduled',
  Sent: 'Sent',
  Completed: 'Completed',
};

interface ListPayment {
  name: string;
  status: string;
  paidBy: { id: number };
  [key: string]: unknown;
}

export async function GET(req: Request) {
  try {
    const userId = await getSessionUserId();

    const [emailSetting, passwordSetting] = await Promise.all([
      getSetting(userId, 'cc_email'),
      getSetting(userId, 'cc_password'),
    ]);
    if (!emailSetting?.value || !passwordSetting?.value) {
      return Response.json({ error: 'CardCenter not configured' }, { status: 400 });
    }

    const { searchParams } = new URL(req.url);
    const statusParam = searchParams.get('status') ?? '';

    const token = await getCcToken(emailSetting.value, passwordSetting.value);

    // Resolve seller ID from reservations
    let sellerId = '';
    try {
      const rRes = await fetch(`${BASE_URL}/Api/Reservations`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (rRes.ok) {
        const rData = await rRes.json() as { items?: { seller: { id: number } }[] } | { seller: { id: number } }[];
        const items = Array.isArray(rData) ? rData : (rData.items ?? []);
        if (items.length > 0) sellerId = String(items[0].seller.id);
      }
    } catch { /* proceed without paidTo */ }

    async function fetchStatus(apiStatus: string): Promise<ListPayment[]> {
      const params = new URLSearchParams({ status: apiStatus });
      if (sellerId) params.set('paidTo', sellerId);
      let items: ListPayment[] = [];
      let pageToken = '';
      do {
        if (pageToken) params.set('pageToken', pageToken);
        const res = await fetch(`${BASE_URL}/Api/Payments?${params}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`CardCenter error ${res.status}`);
        const data = await res.json() as { items?: ListPayment[]; nextPageToken?: string };
        items = items.concat(data.items ?? []);
        pageToken = data.nextPageToken ?? '';
      } while (pageToken);
      return items;
    }

    let allItems: ListPayment[];
    if (!statusParam || statusParam === 'all') {
      const results = await Promise.all(Object.values(API_STATUS_MAP).map(fetchStatus));
      allItems = results.flat();
    } else {
      const apiStatus = API_STATUS_MAP[statusParam] ?? statusParam;
      allItems = await fetchStatus(apiStatus);
    }

    // Fetch detail (with listings) for all payments in parallel
    const withListings = await Promise.all(allItems.map(async p => {
      try {
        const nameMatch = p.name.match(/^P(\d+)-(\d{4})(\d{2})(\d{2})$/);
        if (!nameMatch) return p;
        const [, pSellerId, year, month, day] = nameMatch;
        const segment = STATUS_SEGMENT[p.status] ?? 'Scheduled';
        const url = `${BASE_URL}/Api/Payments/${segment}/${p.paidBy.id}/${pSellerId}/${year}-${month}-${day}`;
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) return p;
        const detail = await res.json() as ListPayment;
        return { ...p, listings: detail.listings };
      } catch {
        return p;
      }
    }));

    return Response.json({ items: withListings });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
