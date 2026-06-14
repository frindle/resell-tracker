import { getSessionUserId } from '@/lib/auth';
import { getSetting } from '@/lib/db';
import { getDeals } from '@/lib/bfmrWeb';

export async function GET() {
  const userId = await getSessionUserId();
  const uid = userId ?? null;
  const emailRow = await getSetting(uid, 'bfmr_email');
  const passwordRow = await getSetting(uid, 'bfmr_password');
  if (!emailRow?.value || !passwordRow?.value) return new Response('BFMR credentials not configured', { status: 400 });

  try {
    const deals = await getDeals(emailRow.value, passwordRow.value, uid);
    return Response.json(deals);
  } catch (e) {
    return new Response(String(e), { status: 502 });
  }
}
