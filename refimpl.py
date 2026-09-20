#!/usr/bin/env python3
"""Reference impl for: bfmrWeb

The gate applies this, runs the verify, and reverts it. It proves two things at
once: the task is SATISFIABLE as specified, and the verify actually ENFORCES
the spec (a refimpl that goes green while a "Must contain" literal is absent
means the verify is benign).

Two edits to lib/bfmrWeb.ts, both additive -- everything already in the file
(imports, login(), fetchTrackerRows, submitTracking, etc.) is preserved:
  1. decodeJwtExpiry() + getSession() uses the JWT's real exp claim (minus a
     5-minute margin) instead of trusting only the stored bfmr_session_expires;
     undecodable tokens fall back to the existing 50-minute-TTL behavior.
  2. seedBfmrWebSession() -- pure upsert helper for the manual browser-capture
     seed route (app/api/bfmr/web-session-seed/route.ts is a thin wrapper).
"""
import pathlib
import sys

wt = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
p = wt / 'lib/bfmrWeb.ts'
t = p.read_text()

# --- edit 1: decodeJwtExpiry helper, right after the SESSION_TTL_MS constant ---
OLD1 = """const SESSION_TTL_MS = 50 * 60 * 1000;"""
NEW1 = """const SESSION_TTL_MS = 50 * 60 * 1000;

// Safety margin applied to a JWT's real exp claim before we trust the cached
// session: refresh 5 minutes early, same spirit as the fixed-TTL constant.
const JWT_EXPIRY_MARGIN_MS = 5 * 60 * 1000;

/**
 * Decode a JWT's `exp` claim (unix seconds) and return it as unix-ms.
 * Returns null when the token is not a decodable three-segment JWT, the
 * payload is not valid base64url JSON, or exp is missing/non-numeric --
 * callers then fall back to their stored-TTL behavior unchanged.
 */
export function decodeJwtExpiry(token: string): number | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 === 2 ? '==' : b64.length % 4 === 3 ? '=' : '';
    const payload = JSON.parse(Buffer.from(b64 + pad, 'base64').toString('utf8'));
    if (typeof payload?.exp !== 'number' || !Number.isFinite(payload.exp)) return null;
    return Math.floor(payload.exp * 1000);
  } catch {
    return null;
  }
}"""

# --- edit 2: getSession() validity check uses the decoded exp claim ---
OLD2 = """  if (token && Date.now() < expires) {
    return { token, xsrf, cookieStr };
  }"""
NEW2 = """  // Prefer the JWT's real exp claim over the stored bfmr_session_expires:
  // BFMR tokens have been observed with a 30-DAY lifetime while we cached for
  // only 50 minutes, re-hitting the (now reCAPTCHA-gated) login far more often
  // than the token requires. Undecodable token -> stored-TTL fallback, which
  // is exactly the pre-change behavior.
  const jwtExpiry = decodeJwtExpiry(token ?? '');
  if (token && Date.now() < ((jwtExpiry != null ? jwtExpiry - JWT_EXPIRY_MARGIN_MS : expires))) {
    return { token, xsrf, cookieStr };
  }"""

# --- edit 3: seedBfmrWebSession helper, right after getSession() ---
OLD3 = """function dateWindow(months = 3): { start: string; end: string } {"""
NEW3 = """/**
 * Manual session seed (bypasses login() and its reCAPTCHA gate entirely).
 * Upserts the same settings keys getSession() reads. expires is computed from
 * the JWT's real exp claim via decodeJwtExpiry(); an undecodable token falls
 * back to now + SESSION_TTL_MS so a seeded session still has a sane window.
 */
export async function seedBfmrWebSession(
  userId: number | null,
  token: string,
  xsrf = '',
  cookieStr = '',
): Promise<{ expires: number }> {
  const jwtExpiry = decodeJwtExpiry(token);
  const expires = (jwtExpiry != null ? jwtExpiry - JWT_EXPIRY_MARGIN_MS : Date.now() + SESSION_TTL_MS);
  await Promise.all([
    upsertSetting(userId, 'bfmr_session_token', token),
    upsertSetting(userId, 'bfmr_session_xsrf', xsrf),
    upsertSetting(userId, 'bfmr_session_cookies', cookieStr),
    upsertSetting(userId, 'bfmr_session_expires', String(expires)),
  ]);
  return { expires };
}

function dateWindow(months = 3): { start: string; end: string } {"""

for old, new in ((OLD1, NEW1), (OLD2, NEW2), (OLD3, NEW3)):
    assert old in t, "refimpl anchor not found -- did the target change?"
    t = t.replace(old, new, 1)
p.write_text(t)

# --- edit 4: thin seed route wrapper (new file; idiom copied from web-login) ---
route_dir = wt / 'app/api/bfmr/web-session-seed'
route_dir.mkdir(parents=True, exist_ok=True)
(route_dir / 'route.ts').write_text("""import { getSessionUserId } from '@/lib/auth';
import { seedBfmrWebSession } from '@/lib/bfmrWeb';

// Manual session seed: a human captures their own real-browser BFMR login
// response (which passes the reCAPTCHA gate) and POSTs it here. Bypasses
// bfmrWeb's login() entirely -- no server-side /api/login call is made.
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const userId = await getSessionUserId();
  if (userId == null) return new Response('Unauthorized', { status: 401 });

  // Accept either the direct shape or the raw BFMR /api/login response.
  const b = body as Record<string, unknown>;
  const token = typeof b.token === 'string' ? b.token : (b.data?.user?.auth_token ?? '');
  if (!token) return Response.json({ error: 'Missing token' }, { status: 400 });

  const xsrf = typeof b.xsrf === 'string' ? b.xsrf : '';
  const cookieStr = typeof b.cookieStr === 'string' ? b.cookieStr : '';

  try {
    const { expires } = await seedBfmrWebSession(userId, token, xsrf, cookieStr);
    return Response.json({ ok: true, expires });
  } catch (e) {
    return new Response(String(e), { status: 502 });
  }
}
""")
print("refimpl applied")
