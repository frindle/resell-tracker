// BuyingGroup auth, the pure part (lib/bgAuth.ts is the database side, lib/buyinggroup.ts the HTTP calls).
//
// BuyingGroup's own web app (buyinggroup.com) keeps a session alive by refreshing: POST /v2/token/refresh
// {refresh} answers {access, access_expires_at, refresh, refresh_expires_at}, and the app stores the NEW refresh
// token and its expiry each time. The tracker used to keep only the access token, so the refresh token saved at
// the last password login ran out on its fixed expiry. A password login can't renew it any more: /v2/token/get
// now wants a reCAPTCHA v2 checkbox token and answers 400 INVALID_CAPTCHA without one. So: keep the rotated
// refresh token, and when the session does run out, say so once and wait for a person instead of retrying a
// login that can't work.

export type BgTokenSet = {
  access: string;
  /** '' when the reply carried none. */
  refresh: string;
  accessExpiresAt: string | null;
  refreshExpiresAt: string | null;
};

const str = (v: unknown) => (typeof v === 'string' ? v : '');
// BuyingGroup sends the expiries as Unix seconds (1798479692); a date string or milliseconds work too. Read as
// milliseconds, seconds land in January 1970 and the session shows as expired the moment it is saved.
const iso = (v: unknown): string | null => {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const n = typeof v === 'number' ? v : /^\s*\d+(\.\d+)?\s*$/.test(v) ? Number(v) : NaN;
  const t = Number.isFinite(n) ? (n < 1e11 ? n * 1000 : n) : new Date(v).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/** Tokens from a login reply ({token: {...}}) or a refresh reply ({access, refresh, ...}). */
export function parseBgTokens(raw: unknown): BgTokenSet {
  const top = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const nested = (top.token && typeof top.token === 'object' ? top.token : {}) as Record<string, unknown>;
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = nested[k] ?? top[k];
      if (v != null && v !== '') return v;
    }
    return undefined;
  };
  return {
    access: str(pick('access', 'auth_token')),
    refresh: str(pick('refresh', 'refresh_token')),
    accessExpiresAt: iso(pick('access_expires_at')),
    refreshExpiresAt: iso(pick('refresh_expires_at')),
  };
}

/** Hides anything token-like: JWTs and long opaque strings. */
export function redactTokens(s: string): string {
  return s
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]*/g, '<token>')
    .replace(/[A-Za-z0-9_\-+/=]{40,}/g, '<redacted>');
}

/** A short reason for a failed auth call, safe to log: BuyingGroup's own message or code, never a token. */
export function bgAuthReason(bodyText: string): string {
  const text = String(bodyText ?? '').trim();
  if (!text) return 'empty reply';
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const errors = (j.errors && typeof j.errors === 'object' ? j.errors : {}) as Record<string, unknown>;
    const parts = [errors.message, j.code, j.detail, j.message, errors.message_code]
      .filter((v): v is string => typeof v === 'string' && v.trim() !== '');
    if (parts.length) return redactTokens([...new Set(parts)].join(': ')).slice(0, 200);
  } catch {
    // not JSON
  }
  return redactTokens(text.replace(/\s+/g, ' ')).slice(0, 200);
}

export class BgAuthError extends Error {
  readonly kind: 'login' | 'refresh';
  readonly status: number | null;
  readonly reason: string;
  constructor(kind: 'login' | 'refresh', status: number | null, reason: string) {
    super(`BuyingGroup ${kind === 'login' ? 'login' : 'token refresh'} failed (${status ?? 'no status'}): ${reason}`);
    this.name = 'BgAuthError';
    this.kind = kind;
    this.status = status;
    this.reason = reason;
  }
}

export const BG_SESSION_EXPIRED_MESSAGE =
  'BuyingGroup session expired. BuyingGroup now needs a browser login (CAPTCHA), so the tracker cannot log in by itself: paste a fresh session in Settings > BuyingGroup.';

export class BgSessionExpiredError extends Error {
  constructor() {
    super(BG_SESSION_EXPIRED_MESSAGE);
    this.name = 'BgSessionExpiredError';
  }
}

/** By name too, so a copy of the class from another server chunk still counts. */
export const isBgSessionExpired = (e: unknown) =>
  e instanceof BgSessionExpiredError || (e instanceof Error && e.name === 'BgSessionExpiredError');

/** A refresh refused with one of these means the saved session is dead; anything else (5xx, network) may pass. */
export const refreshIsDead = (status: number | null) => status === 400 || status === 401 || status === 403;

/** A password login refused for a missing CAPTCHA: only a person in a browser can get past it. */
export const needsBrowserLogin = (status: number | null, reason: string) => status === 400 && /captcha/i.test(reason);

/** After a CAPTCHA refusal, the password login is tried again at most this often (in case BuyingGroup drops it). */
export const BG_LOGIN_RETRY_MS = 24 * 60 * 60 * 1000;

/** Whether to try the password login now, given when the session was last found expired ('' or null: never). */
export function shouldTryPasswordLogin(expiredAt: string | null | undefined, now: Date): boolean {
  if (!expiredAt) return true;
  const t = new Date(expiredAt).getTime();
  return !Number.isFinite(t) || now.getTime() - t >= BG_LOGIN_RETRY_MS;
}

/**
 * The refresh token in what a person pasted: the bare token, the same in quotes (as the browser console prints
 * it), or a JSON object with refresh / refresh_token (a copied localStorage or reply). '' when there is none.
 */
export function pastedRefreshToken(pasted: unknown): string {
  let s = typeof pasted === 'string' ? pasted.trim() : '';
  if (!s) return '';
  if (s.startsWith('{')) {
    try {
      return parseBgTokens(JSON.parse(s)).refresh.trim();
    } catch {
      return '';
    }
  }
  s = s.replace(/^["'`]+|["'`]+$/g, '').trim();
  return /^[\w-]+\.[\w-]+\.[\w-]+$/.test(s) ? s : '';
}
