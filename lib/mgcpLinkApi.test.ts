import test from 'node:test';
import assert from 'node:assert/strict';
import { handleGet, handlePost, handleDelete, type MgcpDeps, type MgcpRow } from './mgcpLinkApi.ts';
import { parseMgcpLink, splitMgcpLinks } from './mgcpLinkParse.ts';

const A = 'https://www.mygiftcardsplus.com/card?c=zAJ%2FSECRETAAAA';
const B = 'https://www.mygiftcardsplus.com/card?c=SECRETBBBB';

function makeDeps(opts: { owner?: number | null; locked?: boolean } = {}) {
  const owner = opts.owner === undefined ? 7 : opts.owner;
  const rows: Array<MgcpRow & { hash: string; enc: string }> = [];
  let nextId = 1;
  const deps: MgcpDeps = {
    getSessionUserId: async () => 7,
    orderVisibleTo: async (_i, u) => u === owner,
    requireOrderUnlocked: async () => (opts.locked ? Response.json({ error: 'locked' }, { status: 409 }) : null),
    listLinks: async () => rows.map(({ id, status, giftCardId, updatedAt }) => ({ id, status, giftCardId, updatedAt })),
    createLink: async (_o, enc, hash) => {
      if (rows.some((r) => r.hash === hash)) return false;
      rows.push({ id: nextId++, status: 'pending', giftCardId: null, updatedAt: null, hash, enc });
      return true;
    },
    deleteLink: async (_o, id) => { const i = rows.findIndex((r) => r.id === id); if (i >= 0) rows.splice(i, 1); },
    encrypt: (s) => 'enc:' + Buffer.from(s).toString('base64'),
  };
  return { deps, rows };
}
const post = (body: unknown) => new Request('http://x/api/orders/42/mgcp-links', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('parseMgcpLink accepts card links and normalises', () => {
  const p = parseMgcpLink(' ' + A + '&utm=x ');
  assert.ok(p.ok);
  assert.equal(p.ok && p.normalized, 'https://www.mygiftcardsplus.com/card?c=zAJ%2FSECRETAAAA');
});

test('parseMgcpLink rejects bad host/path/protocol/token', () => {
  for (const bad of ['nope', 'http://www.mygiftcardsplus.com/card?c=x', 'https://evil.com/card?c=x', 'https://www.mygiftcardsplus.com/other?c=x', 'https://www.mygiftcardsplus.com/card', 'https://u:p@www.mygiftcardsplus.com/card?c=x']) {
    assert.equal(parseMgcpLink(bad).ok, false, bad);
  }
});

test('splitMgcpLinks splits on whitespace and commas', () => {
  assert.deepEqual(splitMgcpLinks(`${A}\n${B}, ${A}`), [A, B, A]);
});

test('POST adds many, dedupes, reports invalid; GET never reveals link', async () => {
  const { deps, rows } = makeDeps();
  const res = await handlePost(deps, post({ text: `${A}\n${B}\n${A}\nbogus` }), '42');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await res.json(), { added: 2, duplicates: 1, invalid: [{ index: 3, error: 'invalid-url' }] });
  assert.equal(rows.length, 2);
  const g = await handleGet(deps, new Request('http://x'), '42');
  const text = await g.text();
  assert.ok(!text.includes('SECRET') && !text.includes('mygiftcardsplus'), text);
  assert.equal(JSON.parse(text).links.length, 2);
  // second post of same link is a duplicate
  const again = await (await handlePost(deps, post({ links: [A] }), '42')).json();
  assert.equal(again.added, 0); assert.equal(again.duplicates, 1);
});

test('errors never echo the link; foreign order 404; locked order blocks', async () => {
  const { deps } = makeDeps({ owner: 9 });
  assert.equal((await handlePost(deps, post({ links: [A] }), '42')).status, 404);
  const l = makeDeps({ locked: true });
  assert.equal((await handlePost(l.deps, post({ links: [A] }), '42')).status, 409);
  const bad = makeDeps();
  const r = await handlePost(bad.deps, post({ links: ['https://evil.com/card?c=SECRETCCCC'] }), '42');
  assert.ok(!(await r.text()).includes('SECRETCCCC'));
  assert.equal((await handlePost(bad.deps, post({}), '42')).status, 400);
});

test('DELETE removes one link by id', async () => {
  const { deps, rows } = makeDeps();
  await handlePost(deps, post({ links: [A, B] }), '42');
  const res = await handleDelete(deps, new Request('http://x/?linkId=1', { method: 'DELETE' }), '42');
  assert.equal(res.status, 200);
  assert.equal(rows.length, 1);
  assert.equal((await handleDelete(deps, new Request('http://x/', { method: 'DELETE' }), '42')).status, 400);
});
