import { getSetting, upsertSetting } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { MERCHANTS_KEY, learnMerchant, parseLearnedMerchants } from '@/lib/merchants';

export const dynamic = 'force-dynamic';

// Stores a person has confirmed on the Email tab (sender domain -> store name).
// Shared by every user: a store's email domain is the same for everyone.

export async function GET() {
  if ((await getSessionUserId()) == null) return Response.json({ error: 'not authenticated' }, { status: 401 });
  return Response.json(parseLearnedMerchants((await getSetting(null, MERCHANTS_KEY))?.value));
}

export async function POST(req: Request) {
  if ((await getSessionUserId()) == null) return Response.json({ error: 'not authenticated' }, { status: 401 });
  const body = await req.json().catch(() => null) as { domain?: unknown; name?: unknown } | null;
  const domain = typeof body?.domain === 'string' ? body.domain : '';
  const name = typeof body?.name === 'string' ? body.name : '';
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain.trim()) || !name.trim()) {
    return Response.json({ error: 'domain and name are required' }, { status: 400 });
  }
  const list = learnMerchant(parseLearnedMerchants((await getSetting(null, MERCHANTS_KEY))?.value), domain, name);
  await upsertSetting(null, MERCHANTS_KEY, JSON.stringify(list));
  return Response.json(list);
}
