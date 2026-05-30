import { getSetting } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { testConnection } from '@/lib/bfmr';

export async function GET() {
  const userId = await getSessionUserId();
  const uid = userId ?? null;

  const [keyRow, secretRow] = await Promise.all([
    getSetting(uid, 'bfmr_api_key'),
    getSetting(uid, 'bfmr_api_secret'),
  ]);
  if (!keyRow?.value || !secretRow?.value)
    return new Response('No credentials configured', { status: 400 });

  const ok = await testConnection({ apiKey: keyRow.value, apiSecret: secretRow.value });
  return new Response(null, { status: ok ? 200 : 502 });
}
