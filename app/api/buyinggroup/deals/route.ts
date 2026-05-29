import { prisma } from '@/lib/db';
import { login, refreshToken, getDeals } from '@/lib/buyinggroup';
import { NextRequest } from 'next/server';

async function getAccessToken(): Promise<string> {
  const storedRefresh = await prisma.setting.findUnique({ where: { key: 'bg_refresh_token' } });

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
      // Fall through to login
    }
  }

  const [emailSetting, passSetting] = await Promise.all([
    prisma.setting.findUnique({ where: { key: 'bg_email' } }),
    prisma.setting.findUnique({ where: { key: 'bg_password' } }),
  ]);
  if (!emailSetting?.value || !passSetting?.value) throw new Error('BuyingGroup not configured');

  const tokens = await login({ email: emailSetting.value, password: passSetting.value });
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
  const emailSetting = await prisma.setting.findUnique({ where: { key: 'bg_email' } });
  if (!emailSetting?.value) return new Response('BuyingGroup not configured', { status: 400 });

  const { searchParams } = new URL(req.url);
  const page = parseInt(searchParams.get('page') ?? '1');
  const pageSize = parseInt(searchParams.get('page_size') ?? '60');
  const dataType = (searchParams.get('data_type') ?? 'on_sale_now') as 'on_sale_now' | 'below_cost' | 'all';
  const title = searchParams.get('title') ?? '';

  try {
    const token = await getAccessToken();
    const data = await getDeals(token, { page, pageSize, dataType, title });
    return Response.json(data);
  } catch (e) {
    return new Response(String(e), { status: 502 });
  }
}
