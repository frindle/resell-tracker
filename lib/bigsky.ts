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

function cookiesFromResponse(res: Response): string {
  // Node 18+ exposes getSetCookie(); fall back to the combined header.
  const raw: string[] = typeof (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === 'function'
    ? (res.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie') as string] : []);
  // Keep only name=value (drop attributes) and dedupe by name, last wins.
  const byName = new Map<string, string>();
  for (const c of raw) {
    const pair = c.split(';')[0].trim();
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    byName.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  return [...byName.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
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

// Verifies the OTP and returns the session cookie string on success.
export async function verifyBigSkyOtp(email: string, otp: string): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/sign-in/email-otp`, {
    method: 'POST',
    headers: AUTH_HEADERS,
    body: JSON.stringify({ email, otp }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`BigSky verify OTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const cookie = cookiesFromResponse(res);
  if (!cookie || !/session/i.test(cookie)) {
    throw new Error('BigSky verify OTP: signed in but no session cookie returned');
  }
  return cookie;
}

// Lightweight liveness check for a stored cookie — hits an authenticated
// tRPC read and returns true iff it comes back with data (not a 401).
export async function bigSkyCookieValid(cookie: string): Promise<boolean> {
  const input = encodeURIComponent(JSON.stringify({ '0': { json: null, meta: { values: ['undefined'] } } }));
  try {
    const res = await fetch(`${BASE}/api/trpc/scan.getScanByUser?batch=1&input=${input}`, {
      headers: { Accept: 'application/json', Cookie: cookie },
    });
    if (!res.ok) return false;
    const data = await res.json().catch(() => null) as Array<{ error?: unknown; result?: unknown }> | null;
    return Array.isArray(data) && !!data[0]?.result;
  } catch {
    return false;
  }
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
