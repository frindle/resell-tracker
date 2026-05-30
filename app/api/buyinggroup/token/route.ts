import { getBgAccessToken, isBgConfigured } from '@/lib/bgAuth';
import { getSessionUserId } from '@/lib/auth';

export async function GET() {
  const userId = await getSessionUserId();
  const uid = userId ?? null;
  if (!await isBgConfigured(uid)) return new Response('BuyingGroup not configured', { status: 400 });
  try {
    const access = await getBgAccessToken(uid);
    return Response.json({ access });
  } catch (e) {
    return new Response(String(e), { status: 502 });
  }
}
