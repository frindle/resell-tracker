import { prisma, getSetting, upsertSetting } from '@/lib/db';
import { login, refreshAccessToken } from '@/lib/buyinggroup';

async function saveTokens(userId: number | null, access: string, refresh?: string) {
  await upsertSetting(userId, 'bg_access_token', access);
  if (refresh) await upsertSetting(userId, 'bg_refresh_token', refresh);
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

// Unused but kept for reference
export { prisma };
