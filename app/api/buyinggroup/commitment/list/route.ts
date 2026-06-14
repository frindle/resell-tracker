import { getBgAccessToken, isBgConfigured } from '@/lib/bgAuth';
import { getSessionUserId } from '@/lib/auth';
import { getCommitments } from '@/lib/buyinggroup';

export async function GET() {
  const userId = await getSessionUserId();
  if (!await isBgConfigured(userId ?? null)) return new Response('BuyingGroup not configured', { status: 400 });
  try {
    const token = await getBgAccessToken(userId ?? null);
    const data = await getCommitments(token);
    return Response.json(data);
  } catch (e) {
    return new Response(String(e), { status: 502 });
  }
}
