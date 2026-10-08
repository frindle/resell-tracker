import test from 'node:test';
import assert from 'node:assert/strict';
import { handleGet, handlePut, handleDelete, type EgiftDeps, type EgiftRow } from './egiftLinkApi.ts';
import { parseCostcoDeliveryLink, maskDeliveryLink, hashLink } from './egiftLink.ts';

const GOOD = 'https://www.memberedelivery.com/?login=SECRETTOKEN123&lang=EN';

function makeDeps(opts: { session?: number | null; owner?: number | null; locked?: boolean } = {}) {
  const calls = { visibleUserIds: [] as Array<number | null>, upserts: [] as Array<[number, string, string]>, deletes: [] as number[] };
  let row: EgiftRow | null = null;
  const session = opts.session === undefined ? 7 : opts.session;
  const owner = opts.owner === undefined ? 7 : opts.owner;
  const deps: EgiftDeps = {
    getSessionUserId: async () => session,
    orderVisibleTo: async (_id, userId) => {
      calls.visibleUserIds.push(userId);
      return userId === owner;
    },
    requireOrderUnlocked: async () => (opts.locked ? Response.json({ error: 'Order is locked' }, { status: 409 }) : null),
    findLink: async () => row,
    upsertLink: async (id, enc, hash) => {
      calls.upserts.push([id, enc, hash]);
      row = { linkEnc: enc, updatedAt: new Date('2026-10-08T00:00:00Z') };
    },
    deleteLink: async (id) => {
      calls.deletes.push(id);
      row = null;
    },
    encrypt: (s) => 'enc:' + Buffer.from(s).toString('base64'),
    decrypt: (s) => Buffer.from(s.slice(4), 'base64').toString(),
  };
  return { deps, calls };
}

const put = (link: unknown) =>
  new Request('http://x/api/orders/42/egift-link', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ link }),
  });
const get = (q = '') => new Request('http://x/api/orders/42/egift-link' + q);

test('SESSION user id is what scopes the order lookup (not a body/query value)', async () => {
  const { deps, calls } = makeDeps({ session: 7, owner: 7 });
  // a request that tries to smuggle a different user in the URL
  const res = await handleGet(deps, get('?userId=99'), '42');
  assert.equal(res.status, 200);
  assert.deepEqual(calls.visibleUserIds, [7]);
});

test('a different session user gets 404 and nothing is touched', async () => {
  const { deps, calls } = makeDeps({ session: 8, owner: 7 });
  assert.equal((await handleGet(deps, get(), '42')).status, 404);
  assert.equal((await handlePut(deps, put(GOOD), '42')).status, 404);
  assert.equal((await handleDelete(deps, get(), '42')).status, 404);
  assert.deepEqual(calls.visibleUserIds, [8, 8, 8]);
  assert.equal(calls.upserts.length, 0);
  assert.equal(calls.deletes.length, 0);
});

test('no session (null) only sees userless orders', async () => {
  const { deps, calls } = makeDeps({ session: null, owner: 7 });
  assert.equal((await handleGet(deps, get(), '42')).status, 404);
  assert.deepEqual(calls.visibleUserIds, [null]);
});

test('GET with no link, PUT, GET masked, GET reveal, DELETE flow', async () => {
  const { deps } = makeDeps();
  const r0 = await handleGet(deps, get(), '42');
  assert.deepEqual(await r0.json(), { hasLink: false, masked: null, updatedAt: null });
  assert.equal(r0.headers.get('cache-control'), 'no-store');

  const rp = await handlePut(deps, put(GOOD), '42');
  assert.equal(rp.status, 200);
  assert.equal(rp.headers.get('cache-control'), 'no-store');

  const r1 = await handleGet(deps, get(), '42');
  const body = await r1.json();
  assert.equal(body.hasLink, true);
  assert.equal(body.masked, maskDeliveryLink());
  assert.ok(!JSON.stringify(body).includes('SECRETTOKEN123'));
  assert.ok(!JSON.stringify(body).includes('enc:'));

  const rr = await handleGet(deps, get('?reveal=1'), '42');
  assert.equal(rr.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await rr.json(), { link: parseCostcoDeliveryLink(GOOD).ok ? (parseCostcoDeliveryLink(GOOD) as { normalized: string }).normalized : '' });

  const rd = await handleDelete(deps, get(), '42');
  assert.equal(rd.status, 200);
  assert.equal(rd.headers.get('cache-control'), 'no-store');
  assert.equal((await (await handleGet(deps, get(), '42')).json()).hasLink, false);
});

test('reveal on an order with no stored link leaks nothing', async () => {
  const { deps } = makeDeps();
  const body = await (await handleGet(deps, get('?reveal=1'), '42')).json();
  assert.deepEqual(body, { hasLink: false, masked: null, updatedAt: null });
});

test('PUT stores ciphertext + hash of the normalized link, never plaintext', async () => {
  const { deps, calls } = makeDeps();
  await handlePut(deps, put(GOOD), '42');
  const norm = (parseCostcoDeliveryLink(GOOD) as { normalized: string }).normalized;
  assert.equal(calls.upserts.length, 1);
  const [id, enc, hash] = calls.upserts[0];
  assert.equal(id, 42);
  assert.ok(!enc.includes('SECRETTOKEN123'));
  assert.equal(hash, hashLink(norm));
});

test('PUT accepts urlencoded form field and rejects bad links with 400, storing nothing, never echoing input', async () => {
  const { deps, calls } = makeDeps();
  const form = new Request('http://x/y', {
    method: 'PUT',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ link: GOOD }).toString(),
  });
  assert.equal((await handlePut(deps, form, '42')).status, 200);
  assert.equal(calls.upserts.length, 1);

  for (const bad of [
    'http://www.memberedelivery.com/?login=ZZZ',
    'javascript:alert(1)',
    'https://memberedelivery.com.evil.io/?login=ZZZ',
    'https://www.evil.com/memberedelivery?login=ZZZ',
    'https://www.memberedelivery.com/?login=',
    '',
  ]) {
    const res = await handlePut(deps, put(bad), '42');
    assert.equal(res.status, 400, bad);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const text = JSON.stringify(await res.json());
    assert.ok(!text.includes('ZZZ') && !text.includes('evil'), text);
  }
  assert.equal(calls.upserts.length, 1);
});

test('malformed JSON body is a 400, not a 500', async () => {
  const { deps } = makeDeps();
  const res = await handlePut(deps, new Request('http://x/y', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{nope' }), '42');
  assert.equal(res.status, 400);
});

test('locked order blocks PUT and DELETE (409, no-store)', async () => {
  const { deps, calls } = makeDeps({ locked: true });
  const a = await handlePut(deps, put(GOOD), '42');
  const b = await handleDelete(deps, get(), '42');
  assert.equal(a.status, 409);
  assert.equal(b.status, 409);
  assert.equal(a.headers.get('cache-control'), 'no-store');
  assert.equal(calls.upserts.length + calls.deletes.length, 0);
});

test('internal errors do not leak the link or exception text', async () => {
  const { deps } = makeDeps();
  deps.upsertLink = async () => {
    throw new Error('boom ' + GOOD);
  };
  const res = await handlePut(deps, put(GOOD), '42');
  assert.equal(res.status, 500);
  assert.ok(!JSON.stringify(await res.json()).includes('SECRETTOKEN123'));
});

test('non-numeric id is 404', async () => {
  const { deps } = makeDeps();
  assert.equal((await handleGet(deps, get(), 'abc')).status, 404);
});

test('mask is fixed and leaks nothing of the login value', () => {
  assert.equal(maskDeliveryLink(GOOD), maskDeliveryLink('https://www.memberedelivery.com/?login=OTHER'));
  assert.ok(!maskDeliveryLink(GOOD).includes('SEC'));
});

test('parseCostcoDeliveryLink rejects lookalikes and userinfo', () => {
  assert.equal(parseCostcoDeliveryLink(GOOD).ok, true);
  assert.equal(parseCostcoDeliveryLink('https://user:pw@www.memberedelivery.com/?login=a').ok, false);
  assert.equal(parseCostcoDeliveryLink('https://www.memberedelivery.com.evil.io/?login=a').ok, false);
});
