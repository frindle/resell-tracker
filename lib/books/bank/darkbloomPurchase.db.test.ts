// DB tests for Darkbloom purchases: mark, push, repost, unmark, and the bank row suggestion, against a real SQLite file.
// Fake fetch and fake capture request; nothing touches the network. Run with `npm run test:books-db`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'dbp-db-'));
process.env.DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
process.env.EXTENSION_DATA_KEY = 'ab'.repeat(32);
execFileSync('npx', ['prisma', 'migrate', 'deploy'], { env: process.env, stdio: 'pipe' });

const { prisma, upsertSetting } = await import('../../db.ts');
const svc = await import('../../darkbloomPurchaseService.ts');
const bank = await import('./service.ts');

after(async () => { await prisma.$disconnect(); rmSync(dir, { recursive: true, force: true }); });

type Call = { path: string; method: string; auth: string | undefined; body: Record<string, unknown> | null };
function ledger(opts: { status?: number } = {}) {
  const calls: Call[] = [];
  let next = 100;
  const deps = (token: string | null = 'fake-key', captures: number[] = []): import('../../darkbloomPurchaseService.ts').Deps => ({
    url: 'https://ledger.example.test', token: token ?? undefined,
    requestCapture: async (_u, o) => { captures.push(o.id); },
    fetch: async (url, init) => {
      const p = url.replace('https://ledger.example.test', '');
      calls.push({ path: p, method: init.method, auth: init.headers.Authorization, body: init.body ? JSON.parse(init.body) : null });
      const status = opts.status ?? 200;
      const body = p === '/v1/accounting/entries' ? { id: next++ } : { ok: true };
      return { status, ok: status < 300, text: async () => JSON.stringify(body) };
    },
  });
  return { calls, deps };
}

let u = 0;
async function setup(extra: Record<string, unknown> = {}) {
  u = (await prisma.user.create({ data: { name: `dbp ${Math.random()}` } })).id;
  const card = await prisma.creditCard.create({ data: { userId: u, name: 'Test Card', last4: '4242' } });
  const o = await prisma.order.create({ data: {
    userId: u, platform: 'Amazon', orderNumber: '000-0000000-0000001', orderDate: new Date('2026-11-20T20:00:00Z'), cost: 20.58,
    itemDescription: 'Electronics (1 items)', cardId: card.id, blockedAddressPattern: 'fake street', ignoredByRule: true, ...extra,
  } });
  return { card, o };
}
const get = (id: number) => prisma.order.findUniqueOrThrow({ where: { id } });

test('mark with generic items: asks for a capture, holds the push; once items are known it posts exactly once', async () => {
  const { o } = await setup();
  const L = ledger(), caps: number[] = [];
  await svc.markPurchases(u, [o.id], undefined, undefined, L.deps('fake-key', caps));
  assert.deepEqual(caps, [o.id]);
  assert.equal(L.calls.length, 0);
  let r = await get(o.id);
  assert.equal(r.darkbloomCategory, 'supplies');
  assert.equal(r.bloomPushNote, 'items');
  assert.equal(r.ignoredByRule, true);
  // the page capture fills the item title
  await prisma.order.update({ where: { id: o.id }, data: { itemDescription: 'USB-C cable 2 pack' } });
  assert.equal(await svc.pushOrder(o.id, L.deps()), 'posted');
  assert.equal(await svc.pushOrder(o.id, L.deps()), 'synced');
  assert.equal(await svc.pushOrder(o.id, L.deps()), 'synced');
  const posts = L.calls.filter(c => c.path === '/v1/accounting/entries');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].auth, 'Bearer fake-key');
  assert.equal(posts[0].body?.amount_cents, 2058);
  assert.equal(posts[0].body?.ref, `resell:order:${o.id}`);
  assert.equal(posts[0].body?.purpose, 'Paid with card ending 4242');
  assert.match(String(posts[0].body?.note), /1 × USB-C cable 2 pack/);
  r = await get(o.id);
  assert.equal(r.bloomEntryId, 100);
  assert.equal(r.bloomPushNote, null);
});

test('no token: pending push, nothing sent; a later token pushes it; a 401 leaves it pending', async () => {
  const { o } = await setup({ itemDescription: 'Mini PC' });
  const L = ledger();
  await svc.markPurchases(u, [o.id], 'hardware', 'm4', L.deps(null));
  assert.equal(L.calls.length, 0);
  assert.equal((await get(o.id)).bloomPushNote, 'no-key');
  const bad = ledger({ status: 401 });
  assert.equal(await svc.pushOrder(o.id, bad.deps()), 'pending');
  assert.equal((await get(o.id)).bloomPushNote, 'auth');
  assert.equal((await get(o.id)).bloomEntryId, null);
  assert.equal(await svc.retryAll(L.deps()).then(x => x.tried), 1);
  const post = L.calls.find(c => c.path === '/v1/accounting/entries')!;
  assert.equal(post.body?.machine_id, 'm4');
  assert.equal(post.body?.category, 'hardware');
});

test('amount change voids the old entry and re-posts with a fresh ref; unmark voids; no token at unmark keeps the id until retry', async () => {
  const { o } = await setup({ itemDescription: 'Mini PC' });
  const L = ledger();
  await svc.markPurchases(u, [o.id], 'supplies', undefined, L.deps());
  const first = (await get(o.id)).bloomEntryId;
  await prisma.order.update({ where: { id: o.id }, data: { cost: 25 } });
  assert.equal(await svc.pushOrder(o.id, L.deps()), 'reposted');
  const r = await get(o.id);
  assert.notEqual(r.bloomEntryId, first);
  const voids = L.calls.filter(c => c.path === '/v1/accounting/entries/void');
  assert.deepEqual(voids.map(v => v.body), [{ id: first }]);
  const posts = L.calls.filter(c => c.path === '/v1/accounting/entries');
  assert.deepEqual(posts.map(p => p.body?.ref), [`resell:order:${o.id}`, `resell:order:${o.id}:r1`]);
  // unmark with no key: the order is no longer Darkbloom, the entry waits to be voided
  await svc.unmarkPurchases(u, [o.id], L.deps(null));
  let x = await get(o.id);
  assert.equal(x.darkbloomCategory, null);
  assert.equal(x.bloomEntryId, r.bloomEntryId);
  await svc.retryAll(L.deps());
  x = await get(o.id);
  assert.equal(x.bloomEntryId, null);
  assert.equal(L.calls.filter(c => c.path === '/v1/accounting/entries/void').length, 2);
  assert.equal(x.ignoredByRule, true); // still blocked by its address pattern
});

test('bank: the card charge of a Darkbloom purchase is suggested as a Darkbloom cost, accepted as a link, no order charge', async () => {
  const { card, o } = await setup({ itemDescription: 'Mini PC', blockedAddressPattern: null });
  await prisma.order.update({ where: { id: o.id }, data: { darkbloomCategory: 'supplies' } });
  const la = await prisma.ledgerAccount.create({ data: { userId: u, code: '2100', name: 'Card', type: 'liability', business: 'shared' } });
  const acct = await prisma.bankAccount.create({ data: { userId: u, provider: 'ofx', providerAccountId: `ofx:${u}`, name: 'Card', creditCardId: card.id, ledgerAccountId: la.id } });
  const t = await prisma.bankTransaction.create({ data: { userId: u, bankAccountId: acct.id, providerTxnId: 't1', source: 'ofx', postedDate: '2026-11-22', amountCents: -2058, description: 'AMAZON MKTPL' } });
  await upsertSetting(u, 'accounting.enabled', 'true');
  await bank.runMatching(u);
  const row = await prisma.bankTransaction.findUniqueOrThrow({ where: { id: t.id } });
  assert.equal(row.matchStatus, 'suggested');
  assert.deepEqual(JSON.parse(row.suggestion!), { kind: 'darkbloom_cost', orderIds: [o.id], exact: true });
  await bank.applyMatchAction(u, t.id, { action: 'accept' });
  const links = await prisma.bankMatch.findMany({ where: { txnId: t.id } });
  assert.deepEqual(links.map(l => [l.kind, l.refId, l.amountCents]), [['darkbloom_cost', o.id, 2058]]);
});
