import { getBgAccessToken, isBgConfigured } from '@/lib/bgAuth';
import { getSessionUserId } from '@/lib/auth';
import { saveCommitment, editCommitment } from '@/lib/buyinggroup';
import { NextRequest } from 'next/server';

export async function POST(req: NextRequest) {
  const userId = await getSessionUserId();
  if (!await isBgConfigured(userId ?? null)) return new Response('BuyingGroup not configured', { status: 400 });
  const { dealKey, itemKey } = await req.json() as { dealKey: string; itemKey: string };
  if (!dealKey || !itemKey) return new Response('dealKey and itemKey required', { status: 400 });
  try {
    const token = await getBgAccessToken(userId ?? null);
    const result = await saveCommitment(token, dealKey, itemKey);
    return Response.json(result);
  } catch (e) {
    return new Response(String(e), { status: 502 });
  }
}

export async function DELETE(req: NextRequest) {
  const userId = await getSessionUserId();
  if (!await isBgConfigured(userId ?? null)) return new Response('BuyingGroup not configured', { status: 400 });
  const { dealKey, itemKey } = await req.json() as { dealKey: string; itemKey: string };
  if (!dealKey || !itemKey) return new Response('dealKey and itemKey required', { status: 400 });
  try {
    const token = await getBgAccessToken(userId ?? null);
    const result = await editCommitment(token, dealKey, itemKey, 0);
    return Response.json(result);
  } catch (e) {
    return new Response(String(e), { status: 502 });
  }
}
