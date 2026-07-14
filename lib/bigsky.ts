const BASE = 'https://www.bigskybuyers.com';
const SUBMIT_URL = `${BASE}/api/trpc/tracking.submitTracking?batch=1`;

// BigSky runs better-auth with the email-OTP plugin. Login is two calls:
//   1. POST /api/auth/email-otp/send-verification-otp  { email, type:"sign-in" }
//        → emails the user a 6-digit code
//   2. POST /api/auth/sign-in/email-otp                { email, otp }
//        → 200 + Set-Cookie session token(s)
// We capture those cookies and store them as the bigsky_cookie setting,
// replacing the old "paste your cookie from DevTools" step.
//
// Caveat: the public signin page also fires a Cloudflare Turnstile
// verify-captcha call. Observed captures show send/verify succeeding without
// a captcha header, so the server flow works; if BigSky later enforces
// Turnstile on these endpoints, this will 403 and the manual-paste fallback
// (still supported) is the workaround.

const AUTH_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json',
  Origin: BASE,
  Referer: `${BASE}/auth/signin`,
  // Match a real browser UA — some CDNs (CloudFront here) reject default
  // fetch UAs on auth endpoints.
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:152.0) Gecko/20100101 Firefox/152.0',
};

export interface BigSkyLogin {
  cookie: string;
  // ISO string of when the session cookie expires, or null if the server
  // set a session cookie with no explicit lifetime (dies when browser
  // closes — for us, effectively unknown).
  expiresAt: string | null;
}

function parseSetCookies(res: Response): { cookie: string; expiresAt: string | null } {
  // Node 18+ exposes getSetCookie(); fall back to the combined header.
  const raw: string[] = typeof (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === 'function'
    ? (res.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie') as string] : []);

  const byName = new Map<string, string>();
  let sessionExpiry: number | null = null;

  for (const c of raw) {
    const segments = c.split(';');
    const pair = segments[0].trim();
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq);
    byName.set(name, pair.slice(eq + 1));

    // Track the expiry of the session cookie specifically (better-auth names
    // it *session_token*). Prefer Max-Age; fall back to Expires.
    if (/session/i.test(name)) {
      let exp: number | null = null;
      for (const seg of segments.slice(1)) {
        const [k, v] = seg.split('=').map(s => s.trim());
        if (/^max-age$/i.test(k) && v) {
          const secs = parseInt(v, 10);
          if (!isNaN(secs)) exp = Date.now() + secs * 1000;
        } else if (/^expires$/i.test(k) && v && exp === null) {
          const t = Date.parse(v);
          if (!isNaN(t)) exp = t;
        }
      }
      if (exp !== null && (sessionExpiry === null || exp > sessionExpiry)) sessionExpiry = exp;
    }
  }

  return {
    cookie: [...byName.entries()].map(([k, v]) => `${k}=${v}`).join('; '),
    expiresAt: sessionExpiry !== null ? new Date(sessionExpiry).toISOString() : null,
  };
}

export async function sendBigSkyOtp(email: string): Promise<void> {
  const res = await fetch(`${BASE}/api/auth/email-otp/send-verification-otp`, {
    method: 'POST',
    headers: AUTH_HEADERS,
    body: JSON.stringify({ email, type: 'sign-in' }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`BigSky send OTP ${res.status}: ${body.slice(0, 200)}`);
  }
}

// Verifies the OTP and returns the session cookie + its expiry on success.
export async function verifyBigSkyOtp(email: string, otp: string): Promise<BigSkyLogin> {
  const res = await fetch(`${BASE}/api/auth/sign-in/email-otp`, {
    method: 'POST',
    headers: AUTH_HEADERS,
    body: JSON.stringify({ email, otp }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`BigSky verify OTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const { cookie, expiresAt } = parseSetCookies(res);
  if (!cookie || !/session/i.test(cookie)) {
    throw new Error('BigSky verify OTP: signed in but no session cookie returned');
  }
  return { cookie, expiresAt };
}

export interface BigSkyScanItem {
  trackingNumber: string;
  itemName: string;
  lineTotal: string;
  scanDate: string;
  paymentDate: string | null;
}

export interface BigSkyNotCheckedInRow {
  tracking: string;
  trackingCreated: string;
  trackingId: number;
  carrier: string;
}

const TRPC_NULL_INPUT = encodeURIComponent(JSON.stringify({ '0': { json: null, meta: { values: ['undefined'] } } }));

export async function bigSkyCookieValid(cookie: string): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/api/trpc/scan.getScanByUser?batch=1&input=${TRPC_NULL_INPUT}`, {
      headers: { Accept: 'application/json', Cookie: cookie },
    });
    if (!res.ok) return false;
    const data = await res.json().catch(() => null) as Array<{ error?: unknown; result?: unknown }> | null;
    return Array.isArray(data) && !!data[0]?.result;
  } catch {
    return false;
  }
}

export async function fetchScanItems(cookie: string): Promise<BigSkyScanItem[]> {
  const res = await fetch(`${BASE}/api/trpc/scan.getScanByUser?batch=1&input=${TRPC_NULL_INPUT}`, {
    headers: { Accept: 'application/json', Cookie: cookie },
  });
  if (!res.ok) throw new Error(`BigSky getScanByUser ${res.status}`);
  const json = await res.json() as [{ result?: { data?: { json?: BigSkyScanItem[] } }; error?: unknown }];
  const items = json?.[0]?.result?.data?.json;
  if (!Array.isArray(items)) throw new Error('Unexpected BigSky getScanByUser response shape');
  return items;
}

export async function fetchNotCheckedInTracking(cookie: string): Promise<BigSkyNotCheckedInRow[]> {
  const res = await fetch(`${BASE}/api/trpc/tracking.getNotCheckedInTracking?batch=1&input=${TRPC_NULL_INPUT}`, {
    headers: { Accept: 'application/json', Cookie: cookie },
  });
  if (!res.ok) throw new Error(`BigSky getNotCheckedInTracking ${res.status}`);
  const json = await res.json() as [{ result?: { data?: { json?: BigSkyNotCheckedInRow[] } }; error?: unknown }];
  const items = json?.[0]?.result?.data?.json;
  if (!Array.isArray(items)) throw new Error('Unexpected BigSky getNotCheckedInTracking response shape');
  return items;
}

export async function submitTracking(cookie: string, trackingNumbers: string[]): Promise<unknown> {
  const res = await fetch(SUBMIT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
    },
    body: JSON.stringify({ '0': { json: { trackingNumbers } } }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`BigSky submit tracking ${res.status}: ${body}`);
  }
  return res.json();
}
