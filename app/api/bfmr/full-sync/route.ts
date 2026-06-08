import { getSetting } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { getMyTracker } from '@/lib/bfmr';
import { NextRequest } from 'next/server';
import { POST as syncOrders } from '@/app/api/bfmr/sync-orders/route';

export async function POST(req: NextRequest) {
  const userId = await getSessionUserId();
  if (!userId) return new Response('Unauthorized', { status: 401 });
  const uid = userId;

  let force = false;
  try { const b = await req.json(); force = b.force === true; } catch { /* no body */ }

  const [k, s] = await Promise.all([
    getSetting(uid, 'bfmr_api_key'),
    getSetting(uid, 'bfmr_api_secret'),
  ]);
  if (!k?.value || !s?.value) return new Response('BFMR not configured', { status: 400 });
  const creds = { apiKey: k.value, apiSecret: s.value };

  let items;
  try {
    items = await getMyTracker(creds);
  } catch (e) {
    return new Response(String(e), { status: 502 });
  }

  // Delegate to sync-orders which has all the latest matching logic
  // (sync start date filtering is handled there, only for new order creation)
  const syncReq = new Request(req.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: req.headers.get('cookie') ?? '' },
    body: JSON.stringify({ items, force }),
  });
  return syncOrders(syncReq as NextRequest);
}
