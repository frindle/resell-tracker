// Adversarial integration test for: bfmrWeb (JWT-expiry caching + manual seed)
//
// Runs under `tsx --test` (tsconfig has @/ paths). External modules are stubbed
// with node:test's mock.module BEFORE the target is first imported, so no DB /
// network / Next runtime is touched. The route handler is driven with a real
// Request and asserted on status + parsed JSON body; getSession()'s caching
// decision is exercised through getProfile() (its only public caller) by
// watching which endpoints the mocked fetch hits.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// tsx runs these files as CJS (no "type":"module"), so bfmrWeb.ts's named
// imports compile to require() calls that consult require.cache. This Node
// build does not ship mock.module, so we seed require.cache with fake modules
// BEFORE the target is first imported -- Module._load returns the cached entry
// without ever loading the real file (so lib/auth's next/headers cookies() and
// lib/db's prisma client are never touched).
function seedStub(specifier: string, exportsObj: Record<string, unknown>) {
  const resolved = require.resolve(specifier);
  (require.cache as Record<string, unknown>)[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

const NOW = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function makeJwt(expSecs: number): string {
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ iat: expSecs - 2_592_000, exp: expSecs })}.sig`;
}

// --- stub externals BEFORE the target is first imported ----------------------
const upsertCalls: Array<[number | null, string, string]> = [];
seedStub('@/lib/db', {
  // bfmrWeb reads `row?.value`, so return the settings-row shape, not a bare string.
  getSetting: async (_userId: number | null, key: string) => {
    const v = (globalThis as Record<string, unknown>).__settings?.[key];
    return v == null ? null : { id: 1, userId: _userId, key, value: String(v) };
  },
  upsertSetting: async (userId: number | null, key: string, value: string) => {
    if ((globalThis as Record<string, unknown>).__failUpsertKey === key) {
      throw new Error(`boom:${key}`);
    }
    upsertCalls.push([userId, key, value]);
  },
});
seedStub('@/lib/apiCallLog', { loggedFetch: (...args: unknown[]) => (globalThis as Record<string, unknown>).__fetch(...(args as [])) });
// Mutable so the unauthenticated case can flip it.
(globalThis as Record<string, unknown>).__authUserId = 7;
seedStub('@/lib/auth', { getSessionUserId: async () => (globalThis as Record<string, unknown>).__authUserId });

const bfmr = () => import('./lib/bfmrWeb');
const routeMod = () => import('./app/api/bfmr/web-session-seed/route');

// --- decodeJwtExpiry ---------------------------------------------------------
test('decodeJwtExpiry: 30-day JWT -> unix-ms exp', async () => {
  const { decodeJwtExpiry } = await bfmr();
  const expSecs = Math.floor((NOW + 30 * DAY_MS) / 1000);
  assert.equal(decodeJwtExpiry(makeJwt(expSecs)), Math.floor(expSecs * 1000));
});

test('decodeJwtExpiry: undecodable inputs -> null (never throws)', async () => {
  const { decodeJwtExpiry } = await bfmr();
  for (const bad of ['not-a-jwt', 'a.b.c.d', '', 'x.!!!base64@@@.y']) {
    assert.equal(decodeJwtExpiry(bad), null);
  }
});

test('decodeJwtExpiry: a 4-segment string is not a JWT -> null (not a base64 fluke)', async () => {
  const { decodeJwtExpiry } = await bfmr();
  assert.equal(decodeJwtExpiry(`${b64url({ alg: 'HS256' })}.${b64url({ exp: 123 })}.sig.extra`), null);
});

test('decodeJwtExpiry: a finite-but-non-number exp is impossible; an INFINITE number exp -> null', async () => {
  const { decodeJwtExpiry } = await bfmr();
  // exp is a NUMBER (typeof check passes) but not finite (Number.isFinite fails) --
  // the only input that makes the two guard clauses disagree, so this is the one
  // case that tells `||` and `&&` apart.
  const token = `${b64url({ alg: 'HS256' })}.${b64url({ iat: 0, exp: Infinity })}.sig`;
  assert.equal(decodeJwtExpiry(token), null);
});

test('decodeJwtExpiry: floors a fractional exp claim to a whole ms', async () => {
  const { decodeJwtExpiry } = await bfmr();
  const token = `${b64url({ alg: 'HS256' })}.${b64url({ iat: 0, exp: 100.0007 })}.sig`;
  assert.equal(decodeJwtExpiry(token), 100000);
});

// --- seed route: happy path ---------------------------------------------------
test('POST web-session-seed: upserts all four settings, expires from JWT exp minus margin', async () => {
  const { POST } = await routeMod();
  const expSecs = Math.floor((NOW + 30 * DAY_MS) / 1000);
  const token = makeJwt(expSecs);
  upsertCalls.length = 0;

  const res = await POST(new Request('http://x/api/bfmr/web-session-seed', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, xsrf: 'xs-123', cookieStr: 'a=1; b=2' }),
  }));

  assert.equal(res.status, 200);
  const body = await res.json() as { ok: boolean; expires: number };
  assert.equal(body.ok, true);
  assert.equal(body.expires, Math.floor(expSecs * 1000) - 5 * 60 * 1000);

  const keys = upsertCalls.map(c => c[1]).sort();
  assert.deepEqual(keys, ['bfmr_session_cookies', 'bfmr_session_expires', 'bfmr_session_token', 'bfmr_session_xsrf']);
  const get = (k: string) => upsertCalls.find(c => c[1] === k)?.[2];
  assert.equal(get('bfmr_session_token'), token);
  assert.equal(get('bfmr_session_xsrf'), 'xs-123');
  assert.equal(get('bfmr_session_cookies'), 'a=1; b=2');
  assert.equal(Number(get('bfmr_session_expires')), Math.floor(expSecs * 1000) - 5 * 60 * 1000);
});

// --- seed route: raw BFMR /api/login response shape ---------------------------
test('POST web-session-seed: accepts raw login response (data.user.auth_token)', async () => {
  const { POST } = await routeMod();
  const expSecs = Math.floor((NOW + 30 * DAY_MS) / 1000);
  upsertCalls.length = 0;

  const res = await POST(new Request('http://x/api/bfmr/web-session-seed', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data: { user: { auth_token: makeJwt(expSecs) } } }),
  }));

  assert.equal(res.status, 200);
  const body = await res.json() as { ok: boolean; expires: number };
  assert.equal(body.ok, true);
  assert.equal(body.expires, Math.floor(expSecs * 1000) - 5 * 60 * 1000);
});

// --- seed route: unhappy paths -------------------------------------------------
test('POST web-session-seed: missing token -> 400 (not 500), nothing upserted', async () => {
  const { POST } = await routeMod();
  upsertCalls.length = 0;
  const res = await POST(new Request('http://x/api/bfmr/web-session-seed', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ xsrf: 'only-xsrf' }),
  }));
  assert.equal(res.status, 400);
  assert.deepEqual(upsertCalls, []);
});

test('POST web-session-seed: invalid JSON body -> 400', async () => {
  const { POST } = await routeMod();
  const res = await POST(new Request('http://x/api/bfmr/web-session-seed', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: '{not json',
  }));
  assert.equal(res.status, 400);
});

test('POST web-session-seed: unauthenticated -> 401, nothing upserted', async () => {
  const { POST } = await routeMod();
  (globalThis as Record<string, unknown>).__authUserId = null;
  try {
    upsertCalls.length = 0;
    const res = await POST(new Request('http://x/api/bfmr/web-session-seed', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: makeJwt(Math.floor((NOW + DAY_MS) / 1000)) }),
    }));
    assert.equal(res.status, 401);
    assert.deepEqual(upsertCalls, []);
  } finally {
    (globalThis as Record<string, unknown>).__authUserId = 7;
  }
});

// --- seed helper fallback: undecodable token -> now + 50min TTL -----------------
test('seedBfmrWebSession: non-JWT token falls back to now + SESSION_TTL_MS', async () => {
  const { seedBfmrWebSession } = await bfmr();
  upsertCalls.length = 0;
  const before = Date.now();
  const { expires } = await seedBfmrWebSession(7, 'opaque-not-a-jwt');
  assert.ok(expires >= before + 50 * 60 * 1000 - 2_000 && expires <= before + 50 * 60 * 1000 + 2_000);
  const get = (k: string) => upsertCalls.find(c => c[1] === k)?.[2];
  assert.equal(get('bfmr_session_token'), 'opaque-not-a-jwt');
});

test('seedBfmrWebSession: an upsert failure propagates (real Promise.all, not a bare array)', async () => {
  const { seedBfmrWebSession } = await bfmr();
  (globalThis as Record<string, unknown>).__failUpsertKey = 'bfmr_session_xsrf';
  try {
    await assert.rejects(() => seedBfmrWebSession(7, 'opaque-token', 'xs', 'c=1'), /boom:bfmr_session_xsrf/);
  } finally {
    (globalThis as Record<string, unknown>).__failUpsertKey = undefined;
  }
});

// --- getSession() caching decision, driven through getProfile ------------------
test('getSession: stale stored expires but live JWT exp -> cached session used (no login call)', async () => {
  const { getProfile } = await bfmr();
  const expSecs = Math.floor((NOW + 30 * DAY_MS) / 1000);
  const token = makeJwt(expSecs);
  (globalThis as Record<string, unknown>).__settings = {
    bfmr_session_token: token,
    bfmr_session_xsrf: 'xs',
    bfmr_session_cookies: 'c=1',
    // stored expiry is STALE (5 min ago) -- a TTL-only implementation would re-login here
    bfmr_session_expires: String(NOW - 5 * 60 * 1000),
  };
  const hits: string[] = [];
  (globalThis as Record<string, unknown>).__fetch = async (_meta: unknown, url: string) => {
    hits.push(String(url));
    if (String(url).includes('/user/profile')) {
      return new Response(JSON.stringify({ data: { user: { api_access: { api_key: 'K', api_secret: 'S' } } } }), { status: 200 });
    }
    if (String(url).includes('get-amazon-extensions-token')) {
      return new Response(JSON.stringify({ data: { token: 'EXT' } }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const out = await getProfile('e@x.com', 'pw', 7);
  assert.deepEqual(out, { apiKey: 'K', apiSecret: 'S', extToken: 'EXT' });
  assert.ok(!hits.some(h => h.includes('/login')), `must not call /api/login when the JWT is still valid; got ${JSON.stringify(hits)}`);
});

test('getSession: expired JWT -> falls through to login() and re-caches with now+TTL', async () => {
  const { getProfile } = await bfmr();
  const deadToken = makeJwt(Math.floor((NOW - DAY_MS) / 1000)); // exp in the past
  (globalThis as Record<string, unknown>).__settings = {
    bfmr_session_token: deadToken,
    bfmr_session_xsrf: '',
    bfmr_session_cookies: '',
    bfmr_session_expires: String(NOW + 30 * DAY_MS), // stored expiry says "fine" -- JWT must override it
  };
  const fresh = makeJwt(Math.floor((NOW + 60 * 60 * 1000) / 1000));
  upsertCalls.length = 0;
  (globalThis as Record<string, unknown>).__fetch = async (_meta: unknown, url: string) => {
    if (String(url).includes('/login')) {
      return new Response(JSON.stringify({ access_token: fresh }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  await assert.rejects(() => getProfile('e@x.com', 'pw', 7)); // profile fetch not mocked -> throws AFTER login
  const tokenCall = upsertCalls.find(c => c[1] === 'bfmr_session_token');
  assert.ok(tokenCall, 'login path must re-cache the session');
  assert.equal(tokenCall?.[2], fresh);
  const expCall = upsertCalls.find(c => c[1] === 'bfmr_session_expires')?.[2];
  assert.ok(expCall && Number(expCall) > NOW + 49 * 60 * 1000, `re-cached expiry should be ~now+50min, got ${expCall}`);
});
