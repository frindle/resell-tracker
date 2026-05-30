import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { login } from '@/lib/buyinggroup';

export async function GET() {
  const userId = await getSessionUserId();
  const uid = userId ?? null;

  const [emailSetting, passSetting] = await Promise.all([
    prisma.setting.findUnique({ where: { userId_key: { userId: uid, key: 'bg_email' } } }),
    prisma.setting.findUnique({ where: { userId_key: { userId: uid, key: 'bg_password' } } }),
  ]);
  if (!emailSetting?.value || !passSetting?.value) {
    return new Response('BuyingGroup not configured', { status: 400 });
  }

  try {
    const tokens = await login({ email: emailSetting.value, password: passSetting.value });
    await Promise.all([
      prisma.setting.upsert({
        where: { userId_key: { userId: uid, key: 'bg_access_token' } },
        create: { userId: uid, key: 'bg_access_token', value: tokens.access },
        update: { value: tokens.access },
      }),
      prisma.setting.upsert({
        where: { userId_key: { userId: uid, key: 'bg_refresh_token' } },
        create: { userId: uid, key: 'bg_refresh_token', value: tokens.refresh },
        update: { value: tokens.refresh },
      }),
    ]);
    return new Response(null, { status: 204 });
  } catch (e) {
    return new Response(String(e), { status: 502 });
  }
}
