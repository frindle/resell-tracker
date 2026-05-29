import { getBgAccessToken, isBgConfigured } from '@/lib/bgAuth';

export async function GET() {
  if (!await isBgConfigured()) return new Response('BuyingGroup not configured', { status: 400 });
  try {
    const access = await getBgAccessToken();
    return Response.json({ access });
  } catch (e) {
    return new Response(String(e), { status: 502 });
  }
}
