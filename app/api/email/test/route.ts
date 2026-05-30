import { getSetting } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { ImapFlow } from 'imapflow';
import { NextRequest } from 'next/server';

export async function POST(req: NextRequest) {
  const userId = await getSessionUserId();
  const uid = userId ?? null;

  const body = await req.json().catch(() => ({})) as Record<string, string>;
  let address = body.address;
  let appPassword = body.appPassword;

  if (!address || !appPassword) {
    const [a, p] = await Promise.all([getSetting(uid, 'gmail_address'), getSetting(uid, 'gmail_app_password')]);
    address = address || a?.value || '';
    appPassword = appPassword || p?.value || '';
  }

  if (!address || !appPassword) return new Response('Not configured', { status: 400 });

  const client = new ImapFlow({
    host: 'imap.gmail.com', port: 993, secure: true,
    auth: { user: address, pass: appPassword },
    logger: false,
  });

  try {
    await client.connect();
    await client.logout();
    return new Response(null, { status: 200 });
  } catch (e) {
    return new Response(String(e), { status: 502 });
  }
}
