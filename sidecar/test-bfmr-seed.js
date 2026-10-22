'use strict';

const { test } = require('node:test');
const assert = require('assert');
const load0 = () => require('./src/bfmrSeed.js');

test('buildSeedPayload returns {token, xsrf, cookieStr} with valid Bearer token and cookies', () => {
  const { buildSeedPayload } = load0();
  const authHeaders = { Authorization: 'Bearer abc.def.ghi', 'X-XSRF-Token': 'xsrftoken123' };
  const cookies = [{ name: 'session', value: 'abc123' }, { name: 'tracking', value: 'xyz789' }];
  const result = buildSeedPayload(authHeaders, cookies);
  assert.notStrictEqual(result, null, 'should not return null when token is present');
  assert.strictEqual(result.token, 'abc.def.ghi');
  assert.strictEqual(result.xsrf, 'xsrftoken123');
  assert.strictEqual(result.cookieStr, 'session=abc123; tracking=xyz789');
});

test('buildSeedPayload strips Bearer prefix case-insensitively and trims whitespace', () => {
  const { buildSeedPayload } = load0();
  const authHeaders = { Authorization: 'beARER  abc.def.ghi  ', 'X-XSRF-Token': ' xsrftok ' };
  const cookies = [];
  const result = buildSeedPayload(authHeaders, cookies);
  assert.notStrictEqual(result, null, 'should not return null when token is present');
  assert.strictEqual(result.token, 'abc.def.ghi');
  assert.strictEqual(result.xsrf, 'xsrftok');
  assert.strictEqual(result.cookieStr, '');
});

test('buildSeedPayload returns null when no Authorization header', () => {
  const { buildSeedPayload } = load0();
  const authHeaders = { 'X-XSRF-Token': 'xsrf' };
  const cookies = [{ name: 'a', value: 'b' }];
  const result = buildSeedPayload(authHeaders, cookies);
  assert.strictEqual(result, null, 'should return null when no Authorization header');
});

test('buildSeedPayload returns null when authHeaders is null', () => {
  const { buildSeedPayload } = load0();
  const result = buildSeedPayload(null, [{ name: 'a', value: 'b' }]);
  assert.strictEqual(result, null, 'should return null when authHeaders is null');
});

test('buildSeedPayload skips cookies with empty name', () => {
  const { buildSeedPayload } = load0();
  const authHeaders = { Authorization: 'Bearer tok' };
  const cookies = [{ name: '', value: 'skipme' }, { name: 'keep', value: 'val' }];
  const result = buildSeedPayload(authHeaders, cookies);
  assert.notStrictEqual(result, null);
  assert.strictEqual(result.cookieStr, 'keep=val');
});

test('buildSeedPayload handles cookies being null/undefined', () => {
  const { buildSeedPayload } = load0();
  const authHeaders = { Authorization: 'Bearer tok' };
  const result = buildSeedPayload(authHeaders, null);
  assert.notStrictEqual(result, null);
  assert.strictEqual(result.cookieStr, '');
  assert.strictEqual(buildSeedPayload(authHeaders, undefined).cookieStr, '');
});

test('buildSeedPayload returns null for undefined/empty/whitespace/bare-Bearer tokens', () => {
  const { buildSeedPayload } = load0();
  assert.strictEqual(buildSeedPayload(undefined, undefined), null);
  assert.strictEqual(buildSeedPayload({}, []), null);
  assert.strictEqual(buildSeedPayload({ Authorization: '' }, []), null);
  assert.strictEqual(buildSeedPayload({ Authorization: '   ' }, []), null);
  assert.strictEqual(buildSeedPayload({ Authorization: 'Bearer' }, []), null);
  assert.strictEqual(buildSeedPayload({ Authorization: 'Bearer   ' }, []), null);
  assert.strictEqual(buildSeedPayload({ Authorization: '  bearer\t ' }, []), null);
  assert.strictEqual(buildSeedPayload({ Authorization: 12345 }, []), null);
});

test('buildSeedPayload strips Bearer after leading whitespace / tabs and keeps raw tokens', () => {
  const { buildSeedPayload } = load0();
  assert.strictEqual(buildSeedPayload({ Authorization: '  BEARER\tabc' }, []).token, 'abc');
  // No scheme: the whole trimmed value is the token.
  assert.strictEqual(buildSeedPayload({ Authorization: ' abc.def ' }, []).token, 'abc.def');
  // "Bearer" glued to the token is not a scheme prefix.
  assert.strictEqual(buildSeedPayload({ Authorization: 'Bearerabc' }, []).token, 'Bearerabc');
});

test('buildSeedPayload xsrf is empty string when absent or non-string', () => {
  const { buildSeedPayload } = load0();
  assert.strictEqual(buildSeedPayload({ Authorization: 'Bearer t' }, []).xsrf, '');
  assert.strictEqual(buildSeedPayload({ Authorization: 'Bearer t', 'X-XSRF-Token': null }, []).xsrf, '');
  assert.strictEqual(buildSeedPayload({ Authorization: 'Bearer t', 'X-XSRF-Token': '   ' }, []).xsrf, '');
});

test('buildSeedPayload tolerates null/nameless cookie entries and missing values', () => {
  const { buildSeedPayload } = load0();
  const cookies = [null, { value: 'x' }, { name: 'a', value: '1' }, { name: 'b' }, { name: 'c', value: 'z=y' }];
  const result = buildSeedPayload({ Authorization: 'Bearer t' }, cookies);
  assert.deepStrictEqual(result, { token: 't', xsrf: '', cookieStr: 'a=1; b=; c=z=y' });
});
