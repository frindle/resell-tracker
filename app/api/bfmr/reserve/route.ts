import { NextRequest } from 'next/server';
import { getSetting } from '@/lib/db';
import { checkAndReserve } from '@/lib/bfmrWeb';
import { getSessionUserId } from '@/lib/auth';

export async function POST(req: NextRequest) {
  try {
  const userId = await getSessionUserId();
  const uid = userId ?? null;

  const emailRow = await getSetting(uid, 'bfmr_email');
  const passwordRow = await getSetting(uid, 'bfmr_password');
  if (!emailRow?.value || !passwordRow?.value) {
    return new Response('BFMR credentials not configured', { status: 400 });
  }

  const { dealSlug, itemId, qty } = await req.json() as { dealSlug: string; itemId: number; qty: number };
  if (!dealSlug || !itemId) return new Response('dealSlug and itemId required', { status: 400 });

  const result = await checkAndReserve(emailRow.value, passwordRow.value, dealSlug, itemId, qty ?? 1, uid);
  return Response.json(result);
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
