import { upsertSetting } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { getProfile } from '@/lib/bfmrWeb';
import { NextRequest } from 'next/server';

export async function POST(req: NextRequest) {
  const userId = await getSessionUserId();
  const { email, password } = await req.json() as { email: string; password: string };
  if (!email || !password) return new Response('Missing credentials', { status: 400 });

  try {
    const { apiKey, apiSecret } = await getProfile(email, password);

    const uid = userId ?? null;
    await Promise.all([
      upsertSetting(uid, 'bfmr_email', email),
      upsertSetting(uid, 'bfmr_password', password),
      upsertSetting(uid, 'bfmr_api_key', apiKey),
      upsertSetting(uid, 'bfmr_api_secret', apiSecret),
    ]);

    return Response.json({ apiKey, apiSecret });
  } catch (e) {
    return new Response(String(e), { status: 502 });
  }
}
