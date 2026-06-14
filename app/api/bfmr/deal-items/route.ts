import { NextRequest } from 'next/server';
import { getSessionUserId } from '@/lib/auth';
import { getSetting } from '@/lib/db';
import { getDealItems } from '@/lib/bfmrWeb';

export async function GET(req: NextRequest) {
  const slug = req.nextUrl.searchParams.get('slug');
  if (!slug) return new Response('Missing slug', { status: 400 });

  const userId = await getSessionUserId();
  const uid = userId ?? null;
  const emailRow = await getSetting(uid, 'bfmr_email');
  const passwordRow = await getSetting(uid, 'bfmr_password');
  if (!emailRow?.value || !passwordRow?.value) return new Response('BFMR credentials not configured', { status: 400 });

  try {
    const info = await getDealItems(emailRow.value, passwordRow.value, slug, uid);
    return Response.json(info);
  } catch (e) {
    return new Response(String(e), { status: 502 });
  }
}
