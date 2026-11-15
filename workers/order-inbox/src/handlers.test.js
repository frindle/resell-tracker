import test from 'node:test';
import assert from 'node:assert/strict';
import { handleEmail, handleFetch, MAX_RAW_BYTES, TTL_SECONDS } from './handlers.js';

function fakeKV() {
  const store = new Map();
  return {
    store,
    async put(key, value, opts) { store.set(key, { value, opts }); },
    async get(key) {
      const e = store.get(key);
      if (!e) return null;
      const v = e.value;
      return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength);
    },
    async delete(key) { store.delete(key); },
    async list({ prefix, limit, cursor }) {
      const names = [...store.keys()].filter(k => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const slice = names.slice(start, start + limit);
      const end = start + slice.length;
      return {
        keys: slice.map(name => ({ name, metadata: store.get(name).opts?.metadata })),
        list_complete: end >= names.length,
        cursor: end >= names.length ? undefined : String(end),
      };
    },
  };
}

function msg(body, extra = {}) {
  const bytes = new TextEncoder().encode(body);
  let rejected = null;
  return {
    to: 'sam@orders.example.test', from: 'shop@retailer.example.test',
    raw: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }),
    setReject(r) { rejected = r; },
    get rejected() { return rejected; },
    ...extra,
  };
}

const req = (path, init = {}, token = 'tok') =>
  new Request('https://w.example.test' + path, { ...init, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers } });

test('email stores raw MIME with ttl and metadata', async () => {
  const env = { ORDER_MAIL: fakeKV() };
  const m = msg('Subject: hi\r\n\r\nbody');
  const key = await handleEmail(m, env, new Date('2026-01-02T03:04:05.000Z'), () => 'uuid-1');
  assert.equal(key, 'm:2026-01-02T03:04:05.000Z:uuid-1');
  const e = env.ORDER_MAIL.store.get(key);
  assert.equal(e.opts.expirationTtl, TTL_SECONDS);
  assert.deepEqual(e.opts.metadata, { to: 'sam@orders.example.test', from: 'shop@retailer.example.test', size: 19, receivedAt: '2026-01-02T03:04:05.000Z' });
  assert.equal(new TextDecoder().decode(e.value), 'Subject: hi\r\n\r\nbody');
  assert.equal(m.rejected, null);
});

test('email over 24 MiB is rejected and not stored', async () => {
  const env = { ORDER_MAIL: fakeKV() };
  const big = new Uint8Array(MAX_RAW_BYTES + 1);
  const m = msg('', { raw: new ReadableStream({ start(c) { c.enqueue(big); c.close(); } }) });
  assert.equal(await handleEmail(m, env), null);
  assert.equal(m.rejected, 'message too large');
  assert.equal(env.ORDER_MAIL.store.size, 0);
  const m2 = msg('x', { rawSize: MAX_RAW_BYTES + 1 });
  await handleEmail(m2, env);
  assert.equal(m2.rejected, 'message too large');
});

test('auth: missing, wrong, and unset token all 401', async () => {
  const env = { ORDER_MAIL: fakeKV(), PULL_TOKEN: 'tok' };
  assert.equal((await handleFetch(req('/messages', {}, null), env)).status, 401);
  assert.equal((await handleFetch(req('/messages', {}, 'nope'), env)).status, 401);
  assert.equal((await handleFetch(req('/messages', {}, 'tok'), { ORDER_MAIL: fakeKV() })).status, 401);
  assert.equal((await handleFetch(req('/messages', {}, ''), { ORDER_MAIL: fakeKV(), PULL_TOKEN: '' })).status, 401);
  assert.equal((await handleFetch(req('/messages', {}, 'tok'), env)).status, 200);
});

test('list paginates with cursor and caps limit', async () => {
  const env = { ORDER_MAIL: fakeKV(), PULL_TOKEN: 'tok' };
  for (let i = 0; i < 3; i++) await handleEmail(msg('b' + i), env, new Date(2026, 0, 1, 0, 0, i), () => 'u' + i);
  const r1 = await (await handleFetch(req('/messages?limit=2'), env)).json();
  assert.equal(r1.messages.length, 2);
  assert.equal(r1.complete, false);
  assert.deepEqual(Object.keys(r1.messages[0]).sort(), ['from', 'id', 'receivedAt', 'size', 'to']);
  const r2 = await (await handleFetch(req('/messages?limit=2&cursor=' + r1.cursor), env)).json();
  assert.equal(r2.messages.length, 1);
  assert.equal(r2.complete, true);
  let seenLimit = 0;
  const spy = { PULL_TOKEN: 'tok', ORDER_MAIL: { list: async o => { seenLimit = o.limit; return { keys: [], list_complete: true }; } } };
  await handleFetch(req('/messages?limit=5000'), spy);
  assert.equal(seenLimit, 100);
});

test('get and delete by url-encoded id; non m: ids and other paths 404', async () => {
  const env = { ORDER_MAIL: fakeKV(), PULL_TOKEN: 'tok' };
  const key = await handleEmail(msg('hello'), env, new Date('2026-02-03T00:00:00.000Z'), () => 'abc');
  const enc = encodeURIComponent(key);
  const g = await handleFetch(req('/messages/' + enc), env);
  assert.equal(g.status, 200);
  assert.equal(g.headers.get('content-type'), 'message/rfc822');
  assert.equal(await g.text(), 'hello');
  assert.equal((await handleFetch(req('/messages/' + encodeURIComponent('m:missing')), env)).status, 404);
  env.ORDER_MAIL.store.set('other', { value: new Uint8Array(1) });
  assert.equal((await handleFetch(req('/messages/other'), env)).status, 404);
  assert.equal((await handleFetch(req('/messages/%E0%A4%A'), env)).status, 404);
  assert.equal((await handleFetch(req('/elsewhere'), env)).status, 404);
  assert.equal((await handleFetch(req('/messages/' + enc, { method: 'DELETE' }), env)).status, 204);
  assert.equal(env.ORDER_MAIL.store.has(key), false);
  assert.equal(env.ORDER_MAIL.store.has('other'), true);
});

// ---------------------------------------------------------------------------
// addy.io webhooks
// ---------------------------------------------------------------------------

import { hmacHex, addyRecipient, addyMime, KEY_PREFIX } from './handlers.js';

const ADDY_ENV = () => ({
  ORDER_MAIL: fakeKV(),
  PULL_TOKEN: 'tok',
  ADDY_WEBHOOK_SECRET: 'whsec-test',
  ADDY_RECIPIENTS: 'sam@orders.example.test, alex@orders.example.test',
});

export const addyPayload = (over = {}) => ({
  id: 'a'.repeat(64),
  event: 'alias.email.received',
  email_type: 'forward',
  alias: { id: 'uuid-alias', email: 'shop.x1@alias.example.test' },
  from: 'orders@costco.com',
  subject: 'Your Costco.com Order Number 1234567890 Has Been Received',
  message_id: 'abc123@costco.example.test',
  size: 1234,
  attachment_count: 0,
  received_at: '2026-11-15T21:00:00+00:00',
  headers: [
    { name: 'from', value: 'Costco <orders@costco.com>' },
    { name: 'to', value: 'shop.x1@alias.example.test' },
    { name: 'subject', value: 'Your Costco.com Order Number 1234567890 Has Been Received' },
    { name: 'date', value: 'Sun, 15 Nov 2026 13:00:00 -0800' },
    { name: 'message-id', value: '<abc123@costco.example.test>' },
    { name: 'content-type', value: 'multipart/mixed; boundary="orig"' },
    { name: 'mime-version', value: '1.0' },
  ],
  text: 'Thank you for your order.\nOrder Number: 1234567890\nTotal $203.29',
  html: '<p>Thank you for your order.</p>',
  truncated: false,
  ...over,
});

async function addyReq(env, path, payload, { secret = env.ADDY_WEBHOOK_SECRET, sig } = {}) {
  const body = JSON.stringify(payload);
  const headers = { 'content-type': 'application/json' };
  const s = sig ?? (secret ? await hmacHex(secret, body) : null);
  if (s) headers['x-addy-signature'] = s;
  return new Request('https://w.example.test' + path, { method: 'POST', headers, body });
}

test('addy: hmacHex matches a known HMAC-SHA256 vector', async () => {
  // RFC 4231 test case 2
  assert.equal(await hmacHex('Jefe', 'what do ya want for nothing?'),
    '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
});

test('addy: signed forward is stored under the mapped orders address', async () => {
  const env = ADDY_ENV();
  const res = await handleFetch(await addyReq(env, '/addy/sam', addyPayload()), env);
  assert.equal(res.status, 204);
  const keys = [...env.ORDER_MAIL.store.keys()];
  assert.deepEqual(keys, [`${KEY_PREFIX}2026-11-15T21:00:00.000Z:addy-${'a'.repeat(64)}`]);
  const e = env.ORDER_MAIL.store.get(keys[0]);
  assert.equal(e.opts.expirationTtl, TTL_SECONDS);
  assert.equal(e.opts.metadata.to, 'sam@orders.example.test');
  assert.equal(e.opts.metadata.from, 'orders@costco.com');
  assert.equal(e.opts.metadata.receivedAt, '2026-11-15T21:00:00.000Z');
  const raw = new TextDecoder().decode(e.value);
  assert.match(raw, /^from: Costco <orders@costco\.com>\r\n/m);
  assert.match(raw, /^delivered-to: sam@orders\.example\.test\r$/m);
  assert.doesNotMatch(raw, /boundary="orig"/);
  assert.equal((raw.match(/^mime-version:/gim) ?? []).length, 1);
  // The pull API serves it like routed mail, still behind the bearer token.
  const list = await (await handleFetch(req('/messages'), env)).json();
  assert.equal(list.messages[0].to, 'sam@orders.example.test');
});

test('addy: retry of the same payload overwrites instead of duplicating', async () => {
  const env = ADDY_ENV();
  for (let i = 0; i < 3; i++) {
    assert.equal((await handleFetch(await addyReq(env, '/addy/sam', addyPayload()), env)).status, 204);
  }
  assert.equal(env.ORDER_MAIL.store.size, 1);
});

test('addy: bad, missing, or wrong-secret signatures are 401 and store nothing', async () => {
  const env = ADDY_ENV();
  assert.equal((await handleFetch(await addyReq(env, '/addy/sam', addyPayload(), { sig: 'deadbeef' }), env)).status, 401);
  assert.equal((await handleFetch(await addyReq(env, '/addy/sam', addyPayload(), { secret: null }), env)).status, 401);
  assert.equal((await handleFetch(await addyReq(env, '/addy/sam', addyPayload(), { secret: 'other' }), env)).status, 401);
  // A body changed after signing fails too.
  const good = await addyReq(env, '/addy/sam', addyPayload());
  const tampered = new Request(good.url, { method: 'POST', headers: good.headers, body: JSON.stringify(addyPayload({ subject: 'x' })) });
  assert.equal((await handleFetch(tampered, env)).status, 401);
  assert.equal(env.ORDER_MAIL.store.size, 0);
});

test('addy: unknown user, unset secret, and non-POST are not webhook hits', async () => {
  const env = ADDY_ENV();
  assert.equal((await handleFetch(await addyReq(env, '/addy/nobody', addyPayload()), env)).status, 404);
  assert.equal((await handleFetch(await addyReq(env, '/addy/%E0%A4%A', addyPayload()), env)).status, 404);
  const noSecret = { ...ADDY_ENV(), ADDY_WEBHOOK_SECRET: '' };
  assert.equal((await handleFetch(await addyReq(noSecret, '/addy/sam', addyPayload(), { secret: 'x' }), noSecret)).status, 404);
  // GET on the path still needs the bearer token like every other route.
  assert.equal((await handleFetch(req('/addy/sam', {}, null), env)).status, 401);
  assert.equal(env.ORDER_MAIL.store.size, 0);
});

test('addy: per-user secret overrides the shared one', async () => {
  const env = { ...ADDY_ENV(), ADDY_WEBHOOK_SECRET_ALEX: 'alex-secret' };
  assert.equal((await handleFetch(await addyReq(env, '/addy/alex', addyPayload()), env)).status, 401);
  assert.equal((await handleFetch(await addyReq(env, '/addy/alex', addyPayload(), { secret: 'alex-secret' }), env)).status, 204);
  assert.equal([...env.ORDER_MAIL.store.values()][0].opts.metadata.to, 'alex@orders.example.test');
});

test('addy: replies, sends, and other events are acknowledged but not stored', async () => {
  const env = ADDY_ENV();
  for (const over of [{ email_type: 'reply' }, { email_type: 'send' }, { event: 'something.else' }]) {
    assert.equal((await handleFetch(await addyReq(env, '/addy/sam', addyPayload(over)), env)).status, 204);
  }
  assert.equal(env.ORDER_MAIL.store.size, 0);
});

test('addy: invalid JSON is 400, oversize is 413', async () => {
  const env = ADDY_ENV();
  const body = 'not json';
  const r = new Request('https://w.example.test/addy/sam', { method: 'POST', body, headers: { 'x-addy-signature': await hmacHex('whsec-test', body) } });
  assert.equal((await handleFetch(r, env)).status, 400);
  const big = 'x'.repeat(4 * 1024 * 1024 + 1);
  const r2 = new Request('https://w.example.test/addy/sam', { method: 'POST', body: big, headers: { 'x-addy-signature': await hmacHex('whsec-test', big) } });
  assert.equal((await handleFetch(r2, env)).status, 413);
  assert.equal(env.ORDER_MAIL.store.size, 0);
});

test('addy: recipient lookup is by local part, case-insensitive', () => {
  const env = ADDY_ENV();
  assert.equal(addyRecipient(env, 'SAM'), 'sam@orders.example.test');
  assert.equal(addyRecipient(env, 'sam@x'), null);
  assert.equal(addyRecipient({}, 'sam'), null);
});

test('addy: mime falls back to payload fields when headers were not included', () => {
  const raw = addyMime(addyPayload({ headers: undefined, html: '' }), 'sam@orders.example.test', 'b');
  assert.match(raw, /^from: orders@costco\.com\r$/m);
  assert.match(raw, /^subject: Your Costco\.com Order Number 1234567890/m);
  assert.match(raw, /^message-id: <abc123@costco\.example\.test>\r$/m);
  assert.match(raw, /^Content-Type: text\/plain; charset=utf-8\r$/m);
  assert.doesNotMatch(raw, /multipart/);
});
