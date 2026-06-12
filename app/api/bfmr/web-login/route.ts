import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { getProfile } from '@/lib/bfmrWeb';
import { NextRequest } from 'next/server';

export async function POST(req: NextRequest) {
  const userId = await getSessionUserId();
  const { email, password } = await req.json() as { email: string; password: string };
  if (!email || !password) return new Response('Missing credentials', { status: 400 });

  try {
    const { apiKey, apiSecret } = await getProfile(email, password);

    // Persist all four credentials
    const uid = userId ?? null;
    await Promise.all([
      prisma.setting.upsert({ where: { userId_key: { userId: uid, key: 'bfmr_email' } }, create: { userId: uid, key: 'bfmr_email', value: email }, update: { value: email } }),
      prisma.setting.upsert({ where: { userId_key: { userId: uid, key: 'bfmr_password' } }, create: { userId: uid, key: 'bfmr_password', value: password }, update: { value: password } }),
      prisma.setting.upsert({ where: { userId_key: { userId: uid, key: 'bfmr_api_key' } }, create: { userId: uid, key: 'bfmr_api_key', value: apiKey }, update: { value: apiKey } }),
      prisma.setting.upsert({ where: { userId_key: { userId: uid, key: 'bfmr_api_secret' } }, create: { userId: uid, key: 'bfmr_api_secret', value: apiSecret }, update: { value: apiSecret } }),
    ]);

    return Response.json({ apiKey, apiSecret });
  } catch (e) {
    return new Response(String(e), { status: 502 });
  }
}
