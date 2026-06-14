import { getBgAccessToken, isBgConfigured } from '@/lib/bgAuth';
import { getSessionUserId } from '@/lib/auth';
import { getCommitmentItems } from '@/lib/buyinggroup';
import { NextRequest } from 'next/server';

export async function GET(req: NextRequest) {
  const userId = await getSessionUserId();
  if (!await isBgConfigured(userId ?? null)) return new Response('BuyingGroup not configured', { status: 400 });
  const dealKey = req.nextUrl.searchParams.get('dealKey');
  if (!dealKey) return new Response('dealKey required', { status: 400 });
  try {
    const token = await getBgAccessToken(userId ?? null);
    const items = await getCommitmentItems(token, dealKey);
    return Response.json(items);
  } catch (e) {
    return new Response(String(e), { status: 502 });
  }
}
