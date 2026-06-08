import { getSetting } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { getMyTracker } from '@/lib/bfmr';
import { prisma } from '@/lib/db';
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

  // Filter by sync start date if configured
  const syncStartSetting = await prisma.setting.findFirst({ where: { userId: uid, key: 'bfmr_sync_start_date' } });
  if (syncStartSetting?.value) {
    const cutoff = new Date(syncStartSetting.value);
    items = items.filter(i => {
      const d = i.reserved_at ? new Date(String(i.reserved_at)) : null;
      return d == null || d >= cutoff;
    });
  }

  // Delegate to sync-orders which has all the latest matching logic
  const syncReq = new Request(req.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: req.headers.get('cookie') ?? '' },
    body: JSON.stringify({ items, force }),
  });
  return syncOrders(syncReq as NextRequest);
}
