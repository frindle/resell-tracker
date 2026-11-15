import { getSetting, upsertSetting } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { INBOX_ADDRESS_KEY, INBOX_PASSWORD_KEY, INBOX_MODE_KEY, CF_URL_KEY, CF_TOKEN_KEY } from '@/lib/emailCreds';
import { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

// The shared order inbox. The app password and pull token never leave the server.
export async function GET() {
  const userId = await getSessionUserId();
  if (userId == null) return Response.json({ error: 'Not signed in' }, { status: 401 });
  const [mode, addr, pass, cfUrl, cfToken] = await Promise.all([
    getSetting(null, INBOX_MODE_KEY),
    getSetting(null, INBOX_ADDRESS_KEY),
    getSetting(null, INBOX_PASSWORD_KEY),
    getSetting(null, CF_URL_KEY),
    getSetting(null, CF_TOKEN_KEY),
  ]);
  const gmailConfigured = Boolean(addr?.value && pass?.value);
  const cfConfigured = Boolean(cfUrl?.value && cfToken?.value);
  const m = mode?.value === 'cloudflare' ? 'cloudflare' : 'gmail';
  return Response.json({
    mode: m,
    address: addr?.value ?? '',
    cfUrl: cfUrl?.value ?? '',
    gmailConfigured,
    cfConfigured,
    configured: m === 'cloudflare' ? cfConfigured : gmailConfigured,
  });
}

export async function POST(req: NextRequest) {
  const userId = await getSessionUserId();
  if (userId == null) return Response.json({ error: 'Not signed in' }, { status: 401 });
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const mode = body.mode === 'cloudflare' ? 'cloudflare' : 'gmail';

  if (mode === 'cloudflare') {
    const url = typeof body.cfUrl === 'string' ? body.cfUrl.trim().replace(/\/+$/, '') : '';
    const token = typeof body.cfToken === 'string' ? body.cfToken.trim() : '';
    if (url && !/^https:\/\/[^\s/]+(\/\S*)?$/.test(url)) {
      return Response.json({ error: 'Worker URL must start with https://' }, { status: 400 });
    }
    await upsertSetting(null, INBOX_MODE_KEY, 'cloudflare');
    await upsertSetting(null, CF_URL_KEY, url);
    // A blank token keeps the saved one; clearing the URL clears both.
    if (token || !url) await upsertSetting(null, CF_TOKEN_KEY, url ? token : '');
    return new Response(null, { status: 204 });
  }

  const address = typeof body.address === 'string' ? body.address.trim() : '';
  const appPassword = typeof body.appPassword === 'string' ? body.appPassword.replace(/\s+/g, '') : '';
  if (address && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) {
    return Response.json({ error: 'Not an email address' }, { status: 400 });
  }
  await upsertSetting(null, INBOX_MODE_KEY, 'gmail');
  await upsertSetting(null, INBOX_ADDRESS_KEY, address);
  // A blank password keeps the saved one; clearing the address clears both.
  if (appPassword || !address) await upsertSetting(null, INBOX_PASSWORD_KEY, address ? appPassword : '');
  return new Response(null, { status: 204 });
}
