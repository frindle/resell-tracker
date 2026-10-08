import { getBgAccessToken, isBgConfigured } from '@/lib/bgAuth';
import { getSessionUserId } from '@/lib/auth';
import { getAllReceipts, getPayments } from '@/lib/buyinggroup';
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
    const [payments, allItems] = await Promise.all([
      getPayments(token),
      getAllReceipts(token),
    ]);
    const requestedTotal = payments
      .filter(p => p.status === 'REQUESTED')
      .reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
    return Response.json({ receipts: allItems, requested_total: requestedTotal });
  } catch (e) {
    console.error('[BG receipts] error:', e);
    return new Response(String(e), { status: 502 });
  }
}
