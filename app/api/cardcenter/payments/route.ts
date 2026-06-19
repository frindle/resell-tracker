import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { getCcToken } from '@/lib/cardcenter';

const BASE_URL = 'https://cardcenter.cc';

export async function GET(req: Request) {
  try {
    const userId = await getSessionUserId();

    const [emailSetting, passwordSetting] = await Promise.all([
      prisma.setting.findFirst({ where: { userId, key: 'cc_email' } }),
      prisma.setting.findFirst({ where: { userId, key: 'cc_password' } }),
    ]);
    if (!emailSetting?.value || !passwordSetting?.value) {
      return Response.json({ error: 'CardCenter not configured' }, { status: 400 });
    }

    const { searchParams } = new URL(req.url);
    const statusParam = searchParams.get('status') ?? '';

    // CardCenter API filter values differ from response status names
    const API_STATUS_MAP: Record<string, string> = {
      Waiting: 'Scheduled',
      Sent: 'Sent',
      Completed: 'Completed',
    };

    const token = await getCcToken(emailSetting.value, passwordSetting.value);

    // Resolve seller ID from reservations so we can filter payments by paidTo
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

    async function fetchStatus(apiStatus: string): Promise<unknown[]> {
      const params = new URLSearchParams({ status: apiStatus });
      if (sellerId) params.set('paidTo', sellerId);
      let items: unknown[] = [];
      let pageToken = '';
      do {
        if (pageToken) params.set('pageToken', pageToken);
        const res = await fetch(`${BASE_URL}/Api/Payments?${params}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`CardCenter error ${res.status}`);
        const data = await res.json() as { items?: unknown[]; nextPageToken?: string };
        items = items.concat(data.items ?? []);
        pageToken = data.nextPageToken ?? '';
      } while (pageToken);
      return items;
    }

    let allItems: unknown[];
    if (!statusParam || statusParam === 'all') {
      const results = await Promise.all(Object.values(API_STATUS_MAP).map(fetchStatus));
      allItems = results.flat();
    } else {
      const apiStatus = API_STATUS_MAP[statusParam] ?? statusParam;
      allItems = await fetchStatus(apiStatus);
    }

    return Response.json({ items: allItems });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
