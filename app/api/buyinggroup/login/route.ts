import { getSetting, upsertSetting } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { login } from '@/lib/buyinggroup';
import { NextRequest } from 'next/server';

export async function GET(req: NextRequest) {
  return POST(req);
}

export async function POST(req: NextRequest) {
  const userId = await getSessionUserId();
  const uid = userId ?? null;

  // Accept credentials directly in body, otherwise fall back to saved settings
  let email: string | undefined;
  let password: string | undefined;

  const contentType = req.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const body = await req.json().catch(() => ({})) as Record<string, string>;
    email = body.email;
    password = body.password;
  }

  if (!email || !password) {
    const [e, p] = await Promise.all([getSetting(uid, 'bg_email'), getSetting(uid, 'bg_password')]);
    email = e?.value;
    password = p?.value;
  }

  if (!email || !password) return new Response('BuyingGroup not configured', { status: 400 });

  try {
    const tokens = await login({ email, password });
    await Promise.all([
      upsertSetting(uid, 'bg_access_token', tokens.access),
      upsertSetting(uid, 'bg_refresh_token', tokens.refresh),
    ]);
    return new Response(null, { status: 204 });
  } catch (e) {
    return new Response(String(e), { status: 502 });
  }
}
