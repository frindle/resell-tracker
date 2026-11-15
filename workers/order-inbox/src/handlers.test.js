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
