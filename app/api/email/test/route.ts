import { getSessionUserId } from '@/lib/auth';
import { orderInboxCreds } from '@/lib/emailCreds';
import { ImapFlow } from 'imapflow';
import { NextRequest } from 'next/server';

// Checks a Gmail login. Values in the body are tried first (the settings
// form before saving); a blank password with the saved address uses the
// saved password.
export async function POST(req: NextRequest) {
  const userId = await getSessionUserId();
  const uid = userId ?? null;

  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  let address = typeof body.address === 'string' ? body.address.trim() : '';
  let appPassword = typeof body.appPassword === 'string' ? body.appPassword.replace(/\s+/g, '') : '';

  if (!address || !appPassword) {
    const saved = await orderInboxCreds(uid);
    if (!address) {
      address = saved?.creds.address ?? '';
      appPassword = appPassword || saved?.creds.appPassword || '';
    } else if (saved && saved.creds.address.toLowerCase() === address.toLowerCase()) {
      appPassword = saved.creds.appPassword;
    }
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
