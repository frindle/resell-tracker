import { getSetting, upsertSetting } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { INBOX_ADDRESS_KEY, INBOX_PASSWORD_KEY } from '@/lib/emailCreds';
import { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

// The shared order inbox. The app password never leaves the server.
export async function GET() {
  const userId = await getSessionUserId();
  if (userId == null) return Response.json({ error: 'Not signed in' }, { status: 401 });
  const [addr, pass] = await Promise.all([
    getSetting(null, INBOX_ADDRESS_KEY),
    getSetting(null, INBOX_PASSWORD_KEY),
  ]);
  return Response.json({ address: addr?.value ?? '', configured: Boolean(addr?.value && pass?.value) });
}

export async function POST(req: NextRequest) {
  const userId = await getSessionUserId();
  if (userId == null) return Response.json({ error: 'Not signed in' }, { status: 401 });
  const body = await req.json().catch(() => ({})) as { address?: unknown; appPassword?: unknown };
  const address = typeof body.address === 'string' ? body.address.trim() : '';
  const appPassword = typeof body.appPassword === 'string' ? body.appPassword.replace(/\s+/g, '') : '';
  if (address && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) {
    return Response.json({ error: 'Not an email address' }, { status: 400 });
  }
  await upsertSetting(null, INBOX_ADDRESS_KEY, address);
  // A blank password keeps the saved one; clearing the address clears both.
  if (appPassword || !address) await upsertSetting(null, INBOX_PASSWORD_KEY, address ? appPassword : '');
  return new Response(null, { status: 204 });
}
