import { getBgAccessToken, isBgConfigured } from '@/lib/bgAuth';
import { getSessionUserId } from '@/lib/auth';
import { getReceipts, getBalance } from '@/lib/buyinggroup';
import { NextRequest } from 'next/server';

export async function GET(req: NextRequest) {
  const userId = await getSessionUserId();
  const configured = await isBgConfigured(userId ?? null);
  console.log('[BG] receipts GET userId:', userId, 'configured:', configured);
  if (!configured) return new Response('BuyingGroup not configured', { status: 400 });

  const { searchParams } = new URL(req.url);
  const page = parseInt(searchParams.get('page') ?? '1');
  const pageSize = parseInt(searchParams.get('page_size') ?? '50');

  try {
    const token = await getBgAccessToken(userId ?? null);
    const [balance, ...pages] = await Promise.all([
      getBalance(token),
      getReceipts(token, 1, 50),
    ]);
    const allItems: unknown[] = [];
    const firstData = pages[0] as Record<string, unknown>;
    const firstPayload = firstData.payload as Record<string, unknown> | undefined;
    const firstItems = Array.isArray(pages[0]) ? pages[0] : ((firstPayload?.receipts ?? firstData.results ?? firstData.data ?? firstData.orders ?? []) as unknown[]);
    allItems.push(...firstItems);
    let p = 2;
    while (firstItems.length >= 50) {
      const data = await getReceipts(token, p, 50);
      const d = data as Record<string, unknown>;
      const payload = d.payload as Record<string, unknown> | undefined;
      const items = Array.isArray(data) ? data : ((payload?.receipts ?? d.results ?? d.data ?? d.orders ?? []) as unknown[]);
      allItems.push(...items);
      if (items.length < 50) break;
      p++;
    }
    return Response.json({ receipts: allItems, remaining_balance: balance.remaining_balance });
  } catch (e) {
    console.error('[BG receipts] error:', e);
    return new Response(String(e), { status: 502 });
  }
}
