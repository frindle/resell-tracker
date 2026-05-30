import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { getMyTracker } from '@/lib/bfmr';
import { NextRequest } from 'next/server';

async function getCreds(uid: number | null) {
  const [k, s] = await Promise.all([
    prisma.setting.findUnique({ where: { userId_key: { userId: uid, key: 'bfmr_api_key' } } }),
    prisma.setting.findUnique({ where: { userId_key: { userId: uid, key: 'bfmr_api_secret' } } }),
  ]);
  if (!k?.value || !s?.value) return null;
  return { apiKey: k.value, apiSecret: s.value };
}

export async function GET(req: NextRequest) {
  const userId = await getSessionUserId();
  const creds = await getCreds(userId ?? null);
  if (!creds) return new Response('BFMR not configured', { status: 400 });

  const sp = req.nextUrl.searchParams;
  const filters = Object.fromEntries(sp.entries()) as Record<string, string>;

  try {
    const items = await getMyTracker(creds, filters);
    return Response.json(items);
  } catch (e) {
    return new Response(String(e), { status: 502 });
  }
}
