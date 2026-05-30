import { getSetting, upsertSetting } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { login } from '@/lib/buyinggroup';

export async function GET() {
  const userId = await getSessionUserId();
  const uid = userId ?? null;

  const [emailSetting, passSetting] = await Promise.all([
    getSetting(uid, 'bg_email'),
    getSetting(uid, 'bg_password'),
  ]);
  if (!emailSetting?.value || !passSetting?.value) {
    return new Response('BuyingGroup not configured', { status: 400 });
  }

  try {
    const tokens = await login({ email: emailSetting.value, password: passSetting.value });
    await Promise.all([
      upsertSetting(uid, 'bg_access_token', tokens.access),
      upsertSetting(uid, 'bg_refresh_token', tokens.refresh),
    ]);
    return new Response(null, { status: 204 });
  } catch (e) {
    return new Response(String(e), { status: 502 });
  }
}
