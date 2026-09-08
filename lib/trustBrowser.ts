import crypto from 'node:crypto';

// "Do not require on this browser" (trust-this-browser) support for login.
//
// The bug this fixes: the app re-prompts for the one-time code / password on
// EVERY login because nothing about a previous "don't ask me again" choice is
// ever persisted — there was no trust cookie at all, and the session cookie
// (resell_uid) has no Max-Age so it dies with the browser. Checking the box
// now sets resell_trust below: a LONG-LIVED (30-day Max-Age), per-user,
// HMAC-signed token that /api/auth/login reads to skip the code prompt for
// this user on this browser.
//
// Security model (same as resell_uid in lib/auth.ts):
//   - value is `<userId>.<HMAC-SHA256(userId) with SESSION_SECRET>` — per-user
//     and unforgeable without SESSION_SECRET; a cookie signed for one user is
//     rejected when logging in as another.
//   - NOT Secure by default: this app's default deployment (docker-compose
//     macvlan, no TLS termination) is plain LAN HTTP, where browsers silently
//     DROP Secure cookies — the exact failure mode that made "don't require on
//     this browser" look broken. Only add Secure when the operator has put TLS
//     in front and opted in via COOKIE_SECURE=true (same rule as lib/auth.ts).

export const TRUST_COOKIE = 'resell_trust';

// 30 days — long-lived by design; the whole point is not re-prompting.
export const TRUST_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

function sign(userId: number): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return String(userId);
  const sig = crypto.createHmac('sha256', secret).update(String(userId)).digest('hex');
  return `${userId}.${sig}`;
}

export function buildTrustCookie(userId: number): string {
  const secure = process.env.COOKIE_SECURE === 'true' ? '; Secure' : '';
  return `${TRUST_COOKIE}=${sign(userId)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${TRUST_MAX_AGE_SECONDS}${secure}`;
}

export function clearTrustCookie(): string {
  const secure = process.env.COOKIE_SECURE === 'true' ? '; Secure' : '';
  return `${TRUST_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secure}`;
}

// Returns the userId this trust cookie is signed for, or null if absent or
// invalid (bad signature / not a number). Mirrors getSessionUserId() in
// lib/auth.ts so both cookies share one verification scheme.
export function trustUserIdFor(value: string | null | undefined): number | null {
  if (!value) return null;

  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    const id = parseInt(value, 10);
    return isNaN(id) ? null : id;
  }

  const [idPart, sigPart] = value.split('.');
  if (!idPart || !sigPart) return null;
  const id = parseInt(idPart, 10);
  if (isNaN(id)) return null;
  const expected = crypto.createHmac('sha256', secret).update(idPart).digest('hex');
  const a = Buffer.from(sigPart);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return id;
}

// The OTP/code gate check: true only when the presented trust cookie is valid
// AND signed for exactly this user — a cookie trusted for another user must
// not waive the prompt here.
export function isTrustedBrowser(value: string | null | undefined, userId: number): boolean {
  return trustUserIdFor(value) === userId;
}
