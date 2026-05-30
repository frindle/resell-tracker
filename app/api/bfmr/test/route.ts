import { getSetting } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { testConnection } from '@/lib/bfmr';
import { NextRequest } from 'next/server';

async function getCredentials(uid: number | null, body: Record<string, string>) {
  const apiKey = body.apiKey || (await getSetting(uid, 'bfmr_api_key'))?.value;
  const apiSecret = body.apiSecret || (await getSetting(uid, 'bfmr_api_secret'))?.value;
  return { apiKey, apiSecret };
}

export async function POST(req: NextRequest) {
  const userId = await getSessionUserId();
  const body = await req.json().catch(() => ({})) as Record<string, string>;
  const { apiKey, apiSecret } = await getCredentials(userId ?? null, body);
  if (!apiKey || !apiSecret) return new Response('No credentials', { status: 400 });
  const ok = await testConnection({ apiKey, apiSecret });
  return new Response(null, { status: ok ? 200 : 502 });
}

// Keep GET for backwards compatibility
export async function GET() {
  const userId = await getSessionUserId();
  const uid = userId ?? null;
  const [k, s] = await Promise.all([getSetting(uid, 'bfmr_api_key'), getSetting(uid, 'bfmr_api_secret')]);
  if (!k?.value || !s?.value) return new Response('No credentials configured', { status: 400 });
  const ok = await testConnection({ apiKey: k.value, apiSecret: s.value });
  return new Response(null, { status: ok ? 200 : 502 });
}
