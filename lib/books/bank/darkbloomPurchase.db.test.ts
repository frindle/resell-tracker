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

// ---- blocked orders: personal link, reclass on Darkbloom mark / unmark ----
const nodeps: import('../../darkbloomPurchaseService.ts').Deps = {
  url: undefined, token: undefined, requestCapture: async () => {}, fetch: async () => { throw new Error('no network in tests'); },
};

async function blockedSetup(opts: { cardless?: boolean; auto?: boolean } = {}) {
  const user = (await prisma.user.create({ data: { name: `bl ${Math.random()}` } })).id;
  for (const [k, v] of [['accounting.enabled', 'true'], ['accounting.goLive', '2027-01-01'], ['accounting.bankPosting', 'true'], ['accounting.autoMatch', opts.auto ? 'true' : 'false']]) await upsertSetting(user, k, v);
  const card = await prisma.creditCard.create({ data: { userId: user, name: 'Test Card', last4: '7316' } });
  const la = await prisma.ledgerAccount.create({ data: { userId: user, code: '2100', name: 'Card', type: 'liability', business: 'shared' } });
  const acct = await prisma.bankAccount.create({ data: { userId: user, provider: 'ofx', providerAccountId: `ofx:${user}`, name: 'Card', creditCardId: card.id, ledgerAccountId: la.id } });
  const mk = (num: string, cost: number) => prisma.order.create({ data: {
    userId: user, platform: 'Amazon', orderNumber: num, orderDate: new Date('2027-02-08T20:00:00Z'), cost, itemDescription: 'Mini PC',
    cardId: opts.cardless ? null : card.id, blockedAddressPattern: 'fake street', ignoredByRule: true,
  } });
  const row = (id: string, cents: number, day = '2027-02-10') => prisma.bankTransaction.create({ data: {
    userId: user, bankAccountId: acct.id, providerTxnId: id, source: 'ofx', postedDate: day, amountCents: cents, description: 'ACME STORE PURCHASE', pending: false,
  } });
  return { user, card, la, acct, mk, row };
}
const bankLines = async (user: number) => {
  const es = await prisma.journalEntry.findMany({ where: { userId: user, source: 'bank', reversedAt: null }, include: { lines: { include: { account: true } } } });
  return es.flatMap(e => e.lines.filter(l => l.account.code !== '2100').map(l => [l.account.code, l.amountCents] as const));
};

test('blocked order: the card charge is suggested as personal for that order, and accepting links it with the order id', async () => {
  const { user, mk, row } = await blockedSetup();
  const o = await mk('000-0000000-0000007', 108.11);
  const t = await row('b1', -10811);
  await bank.runMatching(user);
  const sg = JSON.parse((await prisma.bankTransaction.findUniqueOrThrow({ where: { id: t.id } })).suggestion!);
  assert.deepEqual(sg, { kind: 'personal_order', orderIds: [o.id], numbers: ['000-0000000-0000007'], exact: true });
  await bank.applyMatchAction(user, t.id, { action: 'accept' });
  const l = await prisma.bankMatch.findMany({ where: { txnId: t.id } });
  assert.deepEqual(l.map(x => [x.kind, x.refId, x.amountCents]), [['personal', o.id, 10811]]);
  assert.deepEqual((await bankLines(user)).filter(l => l[0] === '3200'), [['3200', 10811]]);
});

test('blocked order without a card gets no suggestion', async () => {
  const { user, mk, row } = await blockedSetup({ cardless: true });
  await mk('000-0000000-0000008', 108.11);
  const t = await row('b2', -10811);
  await bank.runMatching(user);
  assert.equal((await prisma.bankTransaction.findUniqueOrThrow({ where: { id: t.id } })).matchStatus, 'unmatched');
});

test('auto-accept: only with autoMatch on, one order and one row; two rows for one order stay suggested', async () => {
  const off = await blockedSetup();
  await off.mk('000-0000000-0000009', 50);
  const r0 = await off.row('b3', -5000);
  await bank.runMatching(off.user);
  assert.equal((await prisma.bankTransaction.findUniqueOrThrow({ where: { id: r0.id } })).matchStatus, 'suggested');

  const on = await blockedSetup({ auto: true });
  const o = await on.mk('000-0000000-0000010', 50);
  const r1 = await on.row('b4', -5000);
  await bank.runMatching(on.user);
  const a = await prisma.bankTransaction.findUniqueOrThrow({ where: { id: r1.id } });
  assert.equal(a.matchStatus, 'matched');
  const l = await prisma.bankMatch.findFirstOrThrow({ where: { txnId: r1.id } });
  assert.deepEqual([l.kind, l.refId, l.matchedBy], ['personal', o.id, 'auto:personal_order']);

  const two = await blockedSetup({ auto: true });
  await two.mk('000-0000000-0000011', 70);
  const x = await two.row('b5', -7000), y = await two.row('b6', -7000);
  await bank.runMatching(two.user);
  for (const id of [x.id, y.id]) assert.notEqual((await prisma.bankTransaction.findUniqueOrThrow({ where: { id } })).matchStatus, 'matched');
});

test('marking a blocked order Darkbloom moves its personal link to a Darkbloom cost (no owner draw left); unmarking moves it back', async () => {
  const { user, mk, row } = await blockedSetup();
  const o = await mk('000-0000000-0000012', 108.11);
  const t = await row('b7', -10811);
  const hand = await row('b8', -10811, '2027-02-11');
  await prisma.bankMatch.create({ data: { userId: user, txnId: hand.id, kind: 'personal', refId: 0, amountCents: 10811 } });
  await prisma.bankTransaction.update({ where: { id: hand.id }, data: { matchStatus: 'matched' } });
  await bank.runMatching(user);
  await bank.applyMatchAction(user, t.id, { action: 'accept' });
  assert.equal((await bankLines(user)).filter(l => l[0] === '3200').length, 2); // the hand-made row's draw and this one

  await svc.markPurchases(user, [o.id], 'supplies', undefined, nodeps);
  const mine = await prisma.bankMatch.findMany({ where: { txnId: t.id } });
  assert.deepEqual(mine.map(x => [x.kind, x.refId, x.amountCents]), [['darkbloom_cost', o.id, 10811]]);
  // the hand-made personal link is untouched
  assert.deepEqual((await prisma.bankMatch.findMany({ where: { txnId: hand.id } })).map(x => [x.kind, x.refId]), [['personal', 0]]);
  let lines = await bankLines(user);
  assert.equal(lines.filter(l => l[0] === '2500' && l[1] === 10811).length, 1);
  assert.equal(lines.filter(l => l[0] === '3200').length, 1); // only the hand-made row's draw

  await svc.unmarkPurchases(user, [o.id], nodeps);
  assert.deepEqual((await prisma.bankMatch.findMany({ where: { txnId: t.id } })).map(x => [x.kind, x.refId]), [['personal', o.id]]);
  lines = await bankLines(user);
  assert.equal(lines.filter(l => l[0] === '2500').length, 0);
  assert.equal(lines.filter(l => l[0] === '3200').length, 2);
});

test('split row: only the personal part tied to the order moves; the other part stays', async () => {
  const { user, la, mk, row } = await blockedSetup();
  const o = await mk('000-0000000-0000013', 108.11);
  const t = await row('b9', -30000);
  const cost = await prisma.costEntry.create({ data: { userId: user, business: 'resell', date: '2027-02-10', amountCents: 19189, category: 'postage', vendor: 'Acme', paidFromAccountId: la.id } });
  await prisma.bankMatch.createMany({ data: [
    { userId: user, txnId: t.id, kind: 'personal', refId: o.id, amountCents: 10811 },
    { userId: user, txnId: t.id, kind: 'cost', refId: cost.id, amountCents: 19189 },
  ] });
  await prisma.bankTransaction.update({ where: { id: t.id }, data: { matchStatus: 'matched' } });
  await svc.markPurchases(user, [o.id], 'supplies', undefined, nodeps);
  const kinds = (await prisma.bankMatch.findMany({ where: { txnId: t.id }, orderBy: { kind: 'asc' } })).map(x => [x.kind, x.refId, x.amountCents]);
  assert.deepEqual(kinds, [['cost', cost.id, 19189], ['darkbloom_cost', o.id, 10811]]);
  const es = await prisma.journalEntry.findMany({ where: { userId: user, source: 'bank', reversedAt: null }, include: { lines: { include: { account: true } } } });
  const codes = es.flatMap(e => e.lines.map(l => l.account.code));
  assert.ok(codes.includes('2500') && !codes.includes('3200'));
  await svc.unmarkPurchases(user, [o.id], nodeps);
  assert.deepEqual((await prisma.bankMatch.findMany({ where: { txnId: t.id }, orderBy: { kind: 'asc' } })).map(x => [x.kind, x.refId]), [['cost', cost.id], ['personal', o.id]]);
  const es2 = await prisma.journalEntry.findMany({ where: { userId: user, source: 'bank', reversedAt: null }, include: { lines: { include: { account: true } } } });
  const codes2 = es2.flatMap(e => e.lines.map(l => l.account.code));
  assert.ok(codes2.includes('3200') && !codes2.includes('2500'));
});
