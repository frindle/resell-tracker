import { prisma, getSetting, upsertSetting } from './db';
import { sendBigSkyOtp, verifyBigSkyOtp } from './bigsky';
import { cloudflareCreds, INBOX_MODE_KEY } from './emailCreds';
import { listCloudflareMessages, fetchCloudflareRaw, deleteCloudflareMessages } from './emailCloudflare';
import { runBigSkyAutoLogin } from './bigskyAutoLoginCore';

// Renews a user's BigSky login from the order inbox (see bigskyAutoLoginCore.ts).
// The health check calls this before telling the user to log in again.
// Needs: the Cloudflare order inbox, the user's bigsky_email, and that BigSky
// address delivering to the user's order inbox address.
// Off switch: global setting bigsky_auto_login = "off".

export const AUTO_LOGIN_KEY = 'bigsky_auto_login';
const LAST_TRY_KEY = 'bigsky_auto_login_at';
const FAILS_KEY = 'bigsky_auto_login_fails';
// Each restart runs the health check, so don't ask BigSky for a code more
// often than this. Every failure in a row doubles the wait, up to 2 days, so a
// BigSky address that doesn't reach the inbox doesn't keep sending codes.
const MIN_GAP_MS = 5 * 60 * 60 * 1000;
const MAX_GAP_MS = 48 * 60 * 60 * 1000;

const inFlight = new Set<number | null>();

/** True when a fresh BigSky session was saved for the user. */
export async function tryBigSkyAutoLogin(userId: number | null): Promise<boolean> {
  if (inFlight.has(userId)) return false;
  inFlight.add(userId);
  try {
    const [mode, toggle, emailRow, lastRow, failsRow] = await Promise.all([
      getSetting(null, INBOX_MODE_KEY),
      getSetting(null, AUTO_LOGIN_KEY),
      getSetting(userId, 'bigsky_email'),
      getSetting(userId, LAST_TRY_KEY),
      getSetting(userId, FAILS_KEY),
    ]);
    const email = emailRow?.value?.trim();
    if (mode?.value !== 'cloudflare' || toggle?.value === 'off' || !email) return false;
    const fails = Math.max(0, Number(failsRow?.value) || 0);
    const last = lastRow?.value ? Date.parse(lastRow.value) : NaN;
    if (!isNaN(last) && Date.now() - last < Math.min(MIN_GAP_MS * 2 ** fails, MAX_GAP_MS)) return false;
    const cf = await cloudflareCreds();
    if (!cf) return false;

    await upsertSetting(userId, LAST_TRY_KEY, new Date().toISOString());
    const rules = userId == null ? [] : await prisma.senderRule.findMany({ where: { userId }, select: { pattern: true } });

    const out = await runBigSkyAutoLogin({
      email,
      inboxAddresses: rules.map(r => r.pattern),
      send: sendBigSkyOtp,
      verify: verifyBigSkyOtp,
      list: () => listCloudflareMessages(cf),
      raw: id => fetchCloudflareRaw(cf, id),
      remove: ids => deleteCloudflareMessages(cf, ids),
      now: Date.now,
      sleep: ms => new Promise(r => setTimeout(r, ms)),
    });

    if (!out.ok) {
      await upsertSetting(userId, FAILS_KEY, String(fails + 1));
      console.log(`[bigsky-auto-login] user=${userId ?? 'none'} failed reason=${out.reason}${out.detail ? ` detail=${out.detail}` : ''}`);
      return false;
    }
    // Same settings the manual login (app/api/bigsky/auth/verify-otp) writes.
    await upsertSetting(userId, 'bigsky_cookie', out.login.cookie);
    await upsertSetting(userId, 'bigsky_session_updated', new Date().toISOString());
    await upsertSetting(userId, 'bigsky_session_expires', out.login.expiresAt ?? '');
    await upsertSetting(userId, 'bigsky_needs_login', '');
    await upsertSetting(userId, FAILS_KEY, '0');
    console.log(`[bigsky-auto-login] user=${userId ?? 'none'} renewed expires=${out.login.expiresAt ?? 'unknown'}`);
    return true;
  } catch (e) {
    console.error(`[bigsky-auto-login] user=${userId ?? 'none'} error:`, String(e).slice(0, 200));
    return false;
  } finally {
    inFlight.delete(userId);
  }
}
