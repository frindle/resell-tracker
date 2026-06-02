import { getBgAccessToken, isBgConfigured } from '@/lib/bgAuth';
import { getSessionUserId } from '@/lib/auth';

export async function GET() {
  const userId = await getSessionUserId();
  const configured = await isBgConfigured(userId ?? null);
  if (!configured) return new Response('BuyingGroup not configured', { status: 400 });

  const token = await getBgAccessToken(userId ?? null);

  const [receiptsRaw, ordersRaw] = await Promise.all([
    fetch('https://api.prod.buyinggroup.com/v1/receipt/get_receipts', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ page: 1, page_size: 10 }),
    }).then(r => r.json()),
    fetch('https://api.prod.buyinggroup.com/v1/order/get_orders', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ page: 1, page_size: 10 }),
    }).then(r => r.json()),
  ]);

  return Response.json({ receiptsRaw, ordersRaw });
}
