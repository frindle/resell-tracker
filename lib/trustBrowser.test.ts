/**
 * Regression tests for "do not require on this browser" (trust-this-browser).
 *
 * The bug: the app re-prompted for the one-time code / password on EVERY login
 * because nothing about a previous "don't ask me again" choice was persisted —
 * no trust cookie existed at all, and the session cookie has no Max-Age.
 * Checking the box now sets resell_trust (lib/trustBrowser.ts): a long-lived,
 * per-user, HMAC-signed token that /api/auth/login reads to skip the code
 * prompt for this user on this browser.
 *
 * Asserts:
 *   (a) when the box is checked, the login response sets the trust cookie with
 *       a LONG Max-Age and WITHOUT the Secure attribute over plain HTTP;
 *   (b) a subsequent auth request carrying that cookie is NOT code-challenged.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TRUST_COOKIE,
  TRUST_MAX_AGE_SECONDS,
  buildTrustCookie,
  trustUserIdFor,
  isTrustedBrowser,
} from './trustBrowser.ts';

function withEnv(env: Record<string, string | undefined>, fn: () => void) {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    prev[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k];
  }
  try { fn(); } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

// Parse a Set-Cookie header value into name / value / attribute list.
function parseSetCookie(header: string): { name: string; value: string; attrs: string[] } {
  const [pair, ...attrs] = header.split(';').map(s => s.trim());
  const eq = pair.indexOf('=');
  return { name: pair.slice(0, eq), value: pair.slice(eq + 1), attrs };
}

test('(a) trust cookie is long-lived and NOT Secure over plain HTTP (the Penn bug)', () => {
  withEnv({ SESSION_SECRET: 'test-secret', COOKIE_SECURE: undefined }, () => {
    const { name, attrs } = parseSetCookie(buildTrustCookie(7));
    assert.equal(name, TRUST_COOKIE);

    // Long Max-Age — must survive browser restarts (30 days).
    const maxAge = attrs.find(a => a.startsWith('Max-Age='))?.slice('Max-Age='.length);
    assert.ok(maxAge, 'trust cookie must carry a Max-Age');
    assert.ok(Number(maxAge) >= 60 * 60 * 24 * 30, `Max-Age ${maxAge} is not long-lived`);

    // The root cause of the reported symptom: Secure over plain LAN HTTP makes
    // browsers silently drop the cookie. Must be absent by default…
    assert.ok(!attrs.some(a => /^Secure$/i.test(a)), 'must NOT set Secure on a plain-HTTP deployment');

    // …and keep the usual hardening attributes.
    assert.ok(attrs.includes('HttpOnly'));
    assert.ok(attrs.includes('Path=/'));
    assert.ok(attrs.includes('SameSite=Lax'));
  });
});

test('Secure is added only when the operator opts in via COOKIE_SECURE=true (TLS front door)', () => {
  withEnv({ SESSION_SECRET: 'test-secret', COOKIE_SECURE: 'true' }, () => {
    const { attrs } = parseSetCookie(buildTrustCookie(7));
    assert.ok(attrs.some(a => /^Secure$/i.test(a)), 'COOKIE_SECURE=true must add Secure');
  });
});

test('token is per-user and unforgeable (HMAC-signed, not a static value)', () => {
  withEnv({ SESSION_SECRET: 'test-secret' }, () => {
    const cookie = buildTrustCookie(7);
    const value = parseSetCookie(cookie).value;

    // Signed for user 7 → accepted for user 7…
    assert.equal(trustUserIdFor(value), 7);
    assert.equal(isTrustedBrowser(value, 7), true);

    // …but a cookie trusted for one user must not waive the prompt for another.
    assert.equal(isTrustedBrowser(value, 8), false, 'user-7 trust cookie must not work for user 8');

    // Tampered signature is rejected (unforgeable without SESSION_SECRET).
    const [idPart, sig] = value.split('.');
    assert.equal(trustUserIdFor(`${idPart}.${'0'.repeat(sig.length)}`), null);
    assert.equal(trustUserIdFor('7.deadbeef'), null);

    // A different user's cookie is a different value (per-user, not static).
    assert.notEqual(parseSetCookie(buildTrustCookie(8)).value, value);
  });
});

test('(b) subsequent auth request carrying the trust cookie is NOT code-challenged', () => {
  withEnv({ SESSION_SECRET: 'test-secret' }, () => {
    const value = parseSetCookie(buildTrustCookie(7)).value;

    // Simulate the browser's next login attempt, sending the stored cookie.
    const req = new Request('http://10.0.12.39:8088/api/auth/login', {
      method: 'POST',
      headers: { Cookie: `${TRUST_COOKIE}=${value}` },
    });
    const presented = (req.headers.get('cookie') ?? '').split(';').map(s => s.trim()).find(s => s.startsWith(`${TRUST_COOKIE}=`))?.slice(TRUST_COOKIE.length + 1);

    // The gate in app/api/auth/login/route.ts: challenged only when NOT trusted.
    const challenged = !isTrustedBrowser(presented, 7);
    assert.equal(challenged, false, 'trusted browser must skip the one-time code prompt');
  });
});

test('(b) without the trust cookie (or with another user\'s), the login IS still challenged', () => {
  withEnv({ SESSION_SECRET: 'test-secret' }, () => {
    assert.equal(isTrustedBrowser(null, 7), false, 'no cookie → challenged');
    assert.equal(isTrustedBrowser(undefined, 7), false);

    const other = parseSetCookie(buildTrustCookie(5)).value;
    assert.equal(isTrustedBrowser(other, 7), false, "another user's trust cookie must not waive the prompt");
  });
});

test('no SESSION_SECRET: unsigned fallback matches the resell_uid convention (LAN-only default)', () => {
  withEnv({ SESSION_SECRET: undefined }, () => {
    const value = parseSetCookie(buildTrustCookie(7)).value;
    assert.equal(value, '7');
    assert.equal(isTrustedBrowser('7', 7), true);
    assert.equal(isTrustedBrowser('8', 7), false);
  });
});

test('Max-Age constant is the documented 30 days', () => {
  assert.equal(TRUST_MAX_AGE_SECONDS, 60 * 60 * 24 * 30);
});
