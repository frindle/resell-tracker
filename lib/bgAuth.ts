import { prisma } from '@/lib/db';
import { login, refreshAccessToken } from '@/lib/buyinggroup';

async function saveTokens(access: string, refresh?: string) {
  const ops = [
    prisma.setting.upsert({
      where: { key: 'bg_access_token' },
      create: { key: 'bg_access_token', value: access },
      update: { value: access },
    }),
  ];
  if (refresh) {
    ops.push(
      prisma.setting.upsert({
        where: { key: 'bg_refresh_token' },
        create: { key: 'bg_refresh_token', value: refresh },
        update: { value: refresh },
      }),
    );
  }
  await Promise.all(ops);
}

export async function getBgAccessToken(): Promise<string> {
  const [storedRefresh, emailSetting, passSetting] = await Promise.all([
    prisma.setting.findUnique({ where: { key: 'bg_refresh_token' } }),
    prisma.setting.findUnique({ where: { key: 'bg_email' } }),
    prisma.setting.findUnique({ where: { key: 'bg_password' } }),
  ]);

  if (storedRefresh?.value) {
    try {
      const access = await refreshAccessToken(storedRefresh.value);
      await saveTokens(access);
      return access;
    } catch {
      // Fall through to full login
    }
  }

  if (!emailSetting?.value || !passSetting?.value) {
    throw new Error('BuyingGroup not configured');
  }

  const tokens = await login({ email: emailSetting.value, password: passSetting.value });
  await saveTokens(tokens.access, tokens.refresh);
  return tokens.access;
}

export async function isBgConfigured(): Promise<boolean> {
  const email = await prisma.setting.findUnique({ where: { key: 'bg_email' } });
  return !!email?.value;
}
