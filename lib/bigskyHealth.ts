import { prisma, getSetting, upsertSetting } from './db';
import { bigSkyCookieValid } from './bigsky';
import { logApiError } from './apiErrorLog';

// Proactively detects a dead/expiring BigSky session and flags it so the
// user can re-login before a tracking submit silently fails. Two triggers:
//   1. stored expiry is within EXPIRY_WARN_MS  → warn
//   2. a live authenticated read fails (401)   → dead, needs re-login
// Both raise an API error (which pushes via Pushover + shows in /api-errors)
// and set bigsky_needs_login so Settings can badge it. Deduped so a standing
// bad session pushes once, not every cycle.

const CHECK_MS = 6 * 60 * 60 * 1000; // every 6h
const EXPIRY_WARN_MS = 2 * 24 * 60 * 60 * 1000; // warn when <2 days left

function localDateStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function checkOneUser(userId: number | null): Promise<void> {
  const cookieRow = await getSetting(userId, 'bigsky_cookie');
  const cookie = cookieRow?.value?.trim();
  if (!cookie) return; // not configured — nothing to check

  const expiresRow = await getSetting(userId, 'bigsky_session_expires');
  const expiresAt = expiresRow?.value ? Date.parse(expiresRow.value) : NaN;

  // Live validity check is the source of truth (a session can die before its
  // cookie expiry). Only skip it if the cookie is already past a known expiry.
  const expired = !isNaN(expiresAt) && expiresAt <= Date.now();
  const alive = expired ? false : await bigSkyCookieValid(cookie, userId);

  const today = localDateStr();
  const flaggedRow = await getSetting(userId, 'bigsky_needs_login');

  if (!alive) {
    if (flaggedRow?.value === 'dead') return; // already flagged, don't re-push
    await upsertSetting(userId, 'bigsky_needs_login', 'dead');
    await logApiError({
      userId,
      group: 'BigSky',
      endpoint: '/api/auth/session',
      status: 401,
      context: 'BigSky session invalid — re-login in Settings → BigSky to keep tracking submission working.',
    });
    return;
  }

  // Alive — clear a stale flag, then warn if expiry is close.
  if (flaggedRow?.value) await upsertSetting(userId, 'bigsky_needs_login', '');

  if (!isNaN(expiresAt) && expiresAt - Date.now() < EXPIRY_WARN_MS) {
    const warnedRow = await getSetting(userId, 'bigsky_expiry_warned_on');
    if (warnedRow?.value === today) return; // one warning per day
    await upsertSetting(userId, 'bigsky_expiry_warned_on', today);
    const days = Math.max(0, Math.round((expiresAt - Date.now()) / (24 * 60 * 60 * 1000)));
    await logApiError({
      userId,
      group: 'BigSky',
      endpoint: '/api/auth/session',
      context: `BigSky session expires in ~${days} day(s) — re-login in Settings → BigSky soon.`,
    });
  }
}

export async function checkBigSkySessions(): Promise<void> {
  try {
    // Every distinct user that has a BigSky cookie set, plus the null-user
    // (single-user installs store settings under userId=null).
    const rows = await prisma.setting.findMany({
      where: { key: 'bigsky_cookie' },
      select: { userId: true },
    });
    const userIds = new Set<number | null>(rows.map(r => r.userId));
    for (const uid of userIds) {
      try { await checkOneUser(uid); }
      catch (e) { console.error(`[bigsky-health] user ${uid} failed:`, e); }
    }
  } catch (e) {
    console.error('[bigsky-health] check failed:', e);
  }
}

export function startBigSkyHealthCheck(): void {
  setTimeout(checkBigSkySessions, 90 * 1000); // after boot settles
  setInterval(checkBigSkySessions, CHECK_MS);
}
