import { prisma } from '@/lib/db';
import { login, refreshAccessToken } from '@/lib/buyinggroup';

async function getSetting(userId: number | null, key: string) {
  return prisma.setting.findUnique({ where: { userId_key: { userId, key } } });
}

async function saveTokens(userId: number | null, access: string, refresh?: string) {
  const ops = [
    prisma.setting.upsert({
      where: { userId_key: { userId, key: 'bg_access_token' } },
      create: { userId, key: 'bg_access_token', value: access },
      update: { value: access },
    }),
  ];
  if (refresh) {
    ops.push(
      prisma.setting.upsert({
        where: { userId_key: { userId, key: 'bg_refresh_token' } },
        create: { userId, key: 'bg_refresh_token', value: refresh },
        update: { value: refresh },
      }),
    );
  }
  await Promise.all(ops);
}

export async function getBgAccessToken(userId: number | null): Promise<string> {
  const [storedRefresh, emailSetting, passSetting] = await Promise.all([
    getSetting(userId, 'bg_refresh_token'),
    getSetting(userId, 'bg_email'),
    getSetting(userId, 'bg_password'),
  ]);

  if (storedRefresh?.value) {
    try {
      const access = await refreshAccessToken(storedRefresh.value);
      await saveTokens(userId, access);
      return access;
    } catch {
      // Fall through to full login
    }
  }

  if (!emailSetting?.value || !passSetting?.value) {
    throw new Error('BuyingGroup not configured');
  }

  const tokens = await login({ email: emailSetting.value, password: passSetting.value });
  await saveTokens(userId, tokens.access, tokens.refresh);
  return tokens.access;
}

export async function isBgConfigured(userId: number | null): Promise<boolean> {
  const email = await getSetting(userId, 'bg_email');
  return !!email?.value;
}
