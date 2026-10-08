import { getBgAccessToken, isBgConfigured } from '@/lib/bgAuth';
import { getSessionUserId } from '@/lib/auth';
import { getAllOrders } from '@/lib/buyinggroup';

export async function GET() {
  const userId = await getSessionUserId();
  const configured = await isBgConfigured(userId ?? null);
  if (!configured) return new Response('BuyingGroup not configured', { status: 400 });

  try {
    const token = await getBgAccessToken(userId ?? null);
    const allItems = await getAllOrders(token);
    return Response.json(allItems);
  } catch (e) {
    return new Response(String(e), { status: 502 });
  }
}
