import { prisma } from '@/lib/db';
import { login, refreshToken, getReceipts } from '@/lib/buyinggroup';
import { NextRequest } from 'next/server';

async function getCreds() {
  const [email, pass] = await Promise.all([
    prisma.setting.findUnique({ where: { key: 'bg_email' } }),
    prisma.setting.findUnique({ where: { key: 'bg_password' } }),
  ]);
  if (!email?.value || !pass?.value) return null;
  return { email: email.value, password: pass.value };
}

async function getAccessToken(): Promise<string> {
  const [storedRefresh, creds] = await Promise.all([
    prisma.setting.findUnique({ where: { key: 'bg_refresh_token' } }),
    (async () => {
      const [e, p] = await Promise.all([
        prisma.setting.findUnique({ where: { key: 'bg_email' } }),
        prisma.setting.findUnique({ where: { key: 'bg_password' } }),
      ]);
      return e?.value && p?.value ? { email: e.value, password: p.value } : null;
    })(),
  ]);

  if (storedRefresh?.value) {
    try {
      const data = await refreshToken(storedRefresh.value);
      await prisma.setting.upsert({
        where: { key: 'bg_access_token' },
        create: { key: 'bg_access_token', value: data.access },
        update: { value: data.access },
      });
      return data.access;
    } catch {
      // Fall through
    }
  }

  if (!creds) throw new Error('BuyingGroup not configured');
  const tokens = await login(creds);
  await Promise.all([
    prisma.setting.upsert({
      where: { key: 'bg_access_token' },
      create: { key: 'bg_access_token', value: tokens.access },
      update: { value: tokens.access },
    }),
    prisma.setting.upsert({
      where: { key: 'bg_refresh_token' },
      create: { key: 'bg_refresh_token', value: tokens.refresh },
      update: { value: tokens.refresh },
    }),
  ]);
  return tokens.access;
}

export async function GET(req: NextRequest) {
  const creds = await getCreds();
  if (!creds) return new Response('BuyingGroup not configured', { status: 400 });

  const { searchParams } = new URL(req.url);
  const page = parseInt(searchParams.get('page') ?? '1');
  const pageSize = parseInt(searchParams.get('page_size') ?? '50');

  try {
    const token = await getAccessToken();
    const data = await getReceipts(token, page, pageSize);
    return Response.json(data);
  } catch (e) {
    return new Response(String(e), { status: 502 });
  }
}
