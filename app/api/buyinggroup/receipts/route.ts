import { getBgAccessToken, isBgConfigured } from '@/lib/bgAuth';
import { getSessionUserId } from '@/lib/auth';
import { getReceipts } from '@/lib/buyinggroup';
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
    const data = await getReceipts(token, page, pageSize);
    console.log('[BG] receipts raw:', JSON.stringify(data).slice(0, 500));
    // Normalize to array regardless of response shape
    const d = data as Record<string, unknown>;
    const payload = d.payload as Record<string, unknown> | undefined;
    const items = Array.isArray(data) ? data : (payload?.receipts ?? d.results ?? d.data ?? d.orders ?? []);
    return Response.json(items);
  } catch (e) {
    console.error('[BG receipts] error:', e);
    return new Response(String(e), { status: 502 });
  }
}
