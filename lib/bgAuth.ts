import { getSetting, upsertSetting } from '@/lib/db';
import { login, refreshAccessToken } from '@/lib/buyinggroup';
import { logApiError } from '@/lib/apiErrorLog';
import {
  BgAuthError, BgSessionExpiredError, needsBrowserLogin, refreshIsDead, shouldTryPasswordLogin, type BgTokenSet,
} from '@/lib/bgAuthTokens';

// Why the rotated refresh token is kept, and why a CAPTCHA refusal stops the password login: lib/bgAuthTokens.ts.

/** When the session was last found expired (ISO); '' once a refresh or login works again. */
const EXPIRED_KEY = 'bg_session_expired_at';
const REFRESH_EXPIRES_KEY = 'bg_refresh_expires_at';

async function saveTokens(userId: number | null, t: Partial<BgTokenSet>) {
  if (t.access) await upsertSetting(userId, 'bg_access_token', t.access);
  if (t.refresh) await upsertSetting(userId, 'bg_refresh_token', t.refresh);
  if (t.refreshExpiresAt) await upsertSetting(userId, REFRESH_EXPIRES_KEY, t.refreshExpiresAt);
}

async function markWorking(userId: number | null, wasExpired: string | null | undefined) {
  if (wasExpired) await upsertSetting(userId, EXPIRED_KEY, '');
}

const who = (userId: number | null) => `user ${userId ?? '-'}`;
const until = (t: BgTokenSet) => (t.refresh ? `session renewed until ${t.refreshExpiresAt ?? 'unknown'}` : 'no new session in the reply');

export async function getBgAccessToken(userId: number | null): Promise<string> {
  const [storedRefresh, emailSetting, passSetting, expiredSetting] = await Promise.all([
    getSetting(userId, 'bg_refresh_token'),
    getSetting(userId, 'bg_email'),
    getSetting(userId, 'bg_password'),
    getSetting(userId, EXPIRED_KEY),
  ]);

  if (storedRefresh?.value) {
    try {
      const t = await refreshAccessToken(storedRefresh.value, userId);
      await saveTokens(userId, t);
      await markWorking(userId, expiredSetting?.value);
      console.log(`[BG] ${who(userId)}: access token via refresh, ${until(t)}`);
      return t.access;
    } catch (e) {
      const dead = e instanceof BgAuthError && refreshIsDead(e.status);
      console.log(`[BG] ${who(userId)}: ${String(e)}${dead ? '; the saved session is dead, trying the password login' : ''}`);
      // A BuyingGroup outage or network error: a password login would fail the same way, so report this one.
      if (!dead) throw e;
    }
  }

  if (!emailSetting?.value || !passSetting?.value) {
    throw new Error('BuyingGroup not configured');
  }
  if (!shouldTryPasswordLogin(expiredSetting?.value, new Date())) {
    throw new BgSessionExpiredError();
  }

  let tokens: BgTokenSet;
  try {
    tokens = await login({ email: emailSetting.value, password: passSetting.value }, userId);
  } catch (e) {
    if (!(e instanceof BgAuthError) || !needsBrowserLogin(e.status, e.reason)) throw e;
    const first = !expiredSetting?.value;
    await upsertSetting(userId, EXPIRED_KEY, new Date().toISOString());
    console.log(`[BG] ${who(userId)}: session expired and the password login wants a CAPTCHA; ${first ? 'alerting' : 'already alerted'}`);
    // Once per expiry, not every sync run: the per-user sync error is skipped for this one (lib/bgSync.ts).
    if (first) {
      void logApiError({
        userId,
        group: 'BG',
        endpoint: '/v2/token/get',
        method: 'POST',
        status: e.status ?? undefined,
        context: 'BuyingGroup session expired; it needs a browser login. Paste a fresh session in Settings > BuyingGroup.',
        body: e.reason,
      });
    }
    throw new BgSessionExpiredError();
  }
  await saveTokens(userId, tokens);

  // Login only returns a refresh token — immediately exchange it for an access token
  const t = await refreshAccessToken(tokens.refresh, userId);
  await saveTokens(userId, t);
  await markWorking(userId, expiredSetting?.value);
  console.log(`[BG] ${who(userId)}: access token via login+refresh, ${until(t)}`);
  return t.access;
}

/**
 * Stores a refresh token a person copied from a logged-in buyinggroup.com tab, after checking it works
 * (the check itself rotates it, and the rotated one is what is kept). Throws BgAuthError when BuyingGroup refuses it.
 */
export async function seedBgSession(userId: number | null, refresh: string): Promise<{ refreshExpiresAt: string | null }> {
  const t = await refreshAccessToken(refresh, userId);
  await saveTokens(userId, { ...t, refresh: t.refresh || refresh });
  await upsertSetting(userId, EXPIRED_KEY, '');
  console.log(`[BG] ${who(userId)}: session seeded by hand, ${until(t)}`);
  return { refreshExpiresAt: t.refreshExpiresAt };
}

/** Saves a password login's tokens (Settings' test button) and clears the expired mark. */
export async function saveBgLogin(userId: number | null, t: BgTokenSet) {
  await saveTokens(userId, t);
  await upsertSetting(userId, EXPIRED_KEY, '');
}

export type BgSessionStatus = {
  state: 'none' | 'ok' | 'expired';
  refreshExpiresAt: string | null;
  expiredAt: string | null;
};

/** What Settings shows: no saved session, a session (and until when, once known), or an expired one. */
export async function bgSessionStatus(userId: number | null): Promise<BgSessionStatus> {
  const [refresh, expires, expired] = await Promise.all([
    getSetting(userId, 'bg_refresh_token'),
    getSetting(userId, REFRESH_EXPIRES_KEY),
    getSetting(userId, EXPIRED_KEY),
  ]);
  const refreshExpiresAt = expires?.value || null;
  if (expired?.value) return { state: 'expired', refreshExpiresAt, expiredAt: expired.value };
  if (!refresh?.value) return { state: 'none', refreshExpiresAt: null, expiredAt: null };
  if (refreshExpiresAt && Date.parse(refreshExpiresAt) < Date.now()) return { state: 'expired', refreshExpiresAt, expiredAt: refreshExpiresAt };
  return { state: 'ok', refreshExpiresAt, expiredAt: null };
}

export async function isBgConfigured(userId: number | null): Promise<boolean> {
  const email = await getSetting(userId, 'bg_email');
  return !!email?.value;
}
