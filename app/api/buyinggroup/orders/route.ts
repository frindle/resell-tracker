import { getBgAccessToken, isBgConfigured } from '@/lib/bgAuth';
import { getSessionUserId } from '@/lib/auth';
import { getOrders } from '@/lib/buyinggroup';

export async function GET() {
  const userId = await getSessionUserId();
  const configured = await isBgConfigured(userId ?? null);
  if (!configured) return new Response('BuyingGroup not configured', { status: 400 });

  try {
    const token = await getBgAccessToken(userId ?? null);
    const allItems: unknown[] = [];
    let page = 1;
    while (true) {
      const data = await getOrders(token, page, 50);
      const d = data as Record<string, unknown>;
      const items = Array.isArray(data) ? data : ((d.results ?? d.data ?? []) as unknown[]);
      allItems.push(...items);
      if (items.length < 50) break;
      page++;
    }
    return Response.json(allItems);
  } catch (e) {
    return new Response(String(e), { status: 502 });
  }
}
