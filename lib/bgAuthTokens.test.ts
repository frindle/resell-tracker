import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBgTokens, bgAuthReason, redactTokens, BgAuthError, BgSessionExpiredError, isBgSessionExpired,
  refreshIsDead, needsBrowserLogin, shouldTryPasswordLogin, BG_LOGIN_RETRY_MS, pastedRefreshToken,
} from './bgAuthTokens.ts';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJ0b2tlbl90eXBlIjoicmVmcmVzaCJ9.c2lnbmF0dXJl';

test('parseBgTokens reads a refresh reply, keeping the rotated refresh token and its expiry', () => {
  const t = parseBgTokens({
    access: 'A1', access_expires_at: '2026-11-28T10:00:00Z', refresh: 'R2', refresh_expires_at: '2026-12-05T10:00:00Z',
  });
  assert.deepEqual(t, {
    access: 'A1', refresh: 'R2', accessExpiresAt: '2026-11-28T10:00:00.000Z', refreshExpiresAt: '2026-12-05T10:00:00.000Z',
  });
});

test('parseBgTokens reads the nested login reply and the older key names', () => {
  assert.equal(parseBgTokens({ token: { access: 'A', refresh: 'R' } }).refresh, 'R');
  const old = parseBgTokens({ auth_token: 'A', refresh_token: 'R' });
  assert.equal(old.access, 'A');
  assert.equal(old.refresh, 'R');
});

test('parseBgTokens leaves what is missing empty, and bad dates null', () => {
  assert.deepEqual(parseBgTokens({ access: 'A', refresh_expires_at: 'not a date' }), {
    access: 'A', refresh: '', accessExpiresAt: null, refreshExpiresAt: null,
  });
  assert.deepEqual(parseBgTokens(null), { access: '', refresh: '', accessExpiresAt: null, refreshExpiresAt: null });
});

test('bgAuthReason gives BuyingGroup\'s own message and code', () => {
  const body = JSON.stringify({ code: 'INVALID_CAPTCHA', errors: { message: 'Captcha validation failed' } });
  assert.equal(bgAuthReason(body), 'Captcha validation failed: INVALID_CAPTCHA');
  assert.equal(bgAuthReason(JSON.stringify({ detail: 'Token is invalid or expired', code: 'token_not_valid' })), 'token_not_valid: Token is invalid or expired');
  assert.equal(bgAuthReason(''), 'empty reply');
  assert.equal(bgAuthReason('<html>  Bad\n gateway </html>'), '<html> Bad gateway </html>');
});

test('bgAuthReason and redactTokens never let a token through', () => {
  assert.equal(redactTokens(`bad ${JWT} here`), 'bad <token> here');
  assert.ok(!bgAuthReason(JSON.stringify({ detail: `refresh ${JWT} rejected` })).includes('eyJ'));
  assert.ok(!bgAuthReason(`x${'a'.repeat(60)}`).includes('a'.repeat(40)));
});

test('BgAuthError carries status and reason in its message', () => {
  const e = new BgAuthError('refresh', 401, 'token_not_valid');
  assert.equal(e.message, 'BuyingGroup token refresh failed (401): token_not_valid');
  assert.equal(new BgAuthError('login', null, 'x').message, 'BuyingGroup login failed (no status): x');
});

test('isBgSessionExpired matches by class and by name', () => {
  assert.ok(isBgSessionExpired(new BgSessionExpiredError()));
  const copy = new Error('x');
  copy.name = 'BgSessionExpiredError';
  assert.ok(isBgSessionExpired(copy));
  assert.ok(!isBgSessionExpired(new Error('BuyingGroup not configured')));
  assert.ok(!isBgSessionExpired('BgSessionExpiredError'));
});

test('a refused refresh is dead; an outage is not', () => {
  for (const s of [400, 401, 403]) assert.ok(refreshIsDead(s), String(s));
  for (const s of [429, 500, 502, 503, null]) assert.ok(!refreshIsDead(s), String(s));
});

test('needsBrowserLogin only for a 400 about the CAPTCHA', () => {
  assert.ok(needsBrowserLogin(400, 'Captcha validation failed: INVALID_CAPTCHA'));
  assert.ok(!needsBrowserLogin(400, 'Invalid username or password'));
  assert.ok(!needsBrowserLogin(500, 'captcha service down'));
});

test('shouldTryPasswordLogin waits a day after a CAPTCHA refusal', () => {
  const now = new Date('2026-11-28T12:00:00Z');
  assert.ok(shouldTryPasswordLogin('', now));
  assert.ok(shouldTryPasswordLogin(null, now));
  assert.ok(shouldTryPasswordLogin('garbage', now));
  assert.ok(!shouldTryPasswordLogin('2026-11-28T01:44:00Z', now));
  assert.ok(shouldTryPasswordLogin(new Date(now.getTime() - BG_LOGIN_RETRY_MS).toISOString(), now));
});

test('pastedRefreshToken takes the bare token, a quoted one, or JSON', () => {
  assert.equal(pastedRefreshToken(JWT), JWT);
  assert.equal(pastedRefreshToken(`  "${JWT}"\n`), JWT);
  assert.equal(pastedRefreshToken(`'${JWT}'`), JWT);
  assert.equal(pastedRefreshToken(JSON.stringify({ refresh_token: JWT, auth_token: 'x.y.z' })), JWT);
  assert.equal(pastedRefreshToken(JSON.stringify({ token: { refresh: JWT } })), JWT);
});

test('pastedRefreshToken refuses what is not a token', () => {
  for (const v of ['', '   ', 'hunter2', 'null', '{not json', '{"access":"a"}', 42, undefined]) {
    assert.equal(pastedRefreshToken(v), '', String(v));
  }
});
