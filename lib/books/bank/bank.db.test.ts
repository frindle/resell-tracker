// DB-level tests for the bank feed against a real SQLite file (migrations applied to a temp DB).
// Run with `npm run test:books-db`. Uses an injected fake fetch; nothing touches the network.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'bank-db-'));
process.env.DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
const KEY = 'ab'.repeat(32); // made-up 64-hex key
process.env.EXTENSION_DATA_KEY = KEY;
execFileSync('npx', ['prisma', 'migrate', 'deploy'], { env: process.env, stdio: 'pipe' });

const { prisma } = await import('../../db.ts');
const svc = await import('./service.ts');
const { runWithBooks } = await import('../api.ts');
const { upsertSetting } = await import('../../db.ts');

type Resp = { status: number; ok: boolean; text(): Promise<string> };
const resp = (status: number, body: string): Resp => ({ status, ok: status >= 200 && status < 300, text: async () => body });
const E = (d: string) => Math.floor(Date.parse(`${d}T12:00:00Z`) / 1000);
const TOKEN = Buffer.from('https://bridge.example.test/simplefin/claim/FAKE').toString('base64');
const ACCESS = 'https://fake-user:fake-pass@bridge.example.test/simplefin';

let u1 = 0, u2 = 0;
let claims = 0;
let accountsBody: unknown = {};
const fakeFetch = async (url: string, init?: { method?: string }) => {
  if (init?.method === 'POST') { claims++; return resp(200, ACCESS); }
  return resp(200, JSON.stringify(accountsBody));
};
const acctBody = (txns: unknown[]) => ({
  errlist: [{ code: 'con.auth', msg: 'Sign in again at the fake bank', conn_id: 'C1' }],
  connections: [{ conn_id: 'C1', name: 'Fake Bank', org_id: 'fake.example' }],
  accounts: [{ id: 'A1', name: 'Everyday Checking', conn_id: 'C1', currency: 'USD', balance: '100.00', 'balance-date': E('2026-11-10'), transactions: txns }],
});

before(async () => {
  u1 = (await prisma.user.create({ data: { name: 'one' } })).id;
  u2 = (await prisma.user.create({ data: { name: 'two' } })).id;
});
after(async () => { await prisma.$disconnect(); rmSync(dir, { recursive: true, force: true }); });

test('connect refuses without the encryption key and does not claim the token', async () => {
  delete process.env.EXTENSION_DATA_KEY;
  try {
    await assert.rejects(svc.connectSimpleFin(u1, TOKEN, { fetch: fakeFetch }), /EXTENSION_DATA_KEY/);
    assert.equal(claims, 0); // the single-use token was not spent
    assert.equal(await prisma.bankConnection.count({ where: { userId: u1 } }), 0);
  } finally { process.env.EXTENSION_DATA_KEY = KEY; }
});

test('connect stores the Access URL encrypted, never in the clear', async () => {
  await svc.connectSimpleFin(u1, TOKEN, { fetch: fakeFetch });
  assert.equal(claims, 1);
  const c = await prisma.bankConnection.findFirstOrThrow({ where: { userId: u1 } });
  assert.match(c.accessUrlEnc, /^v1:/);
  assert.ok(!c.accessUrlEnc.includes('fake-pass'));
  const st = await svc.connectionStatus(u1);
  assert.ok(!JSON.stringify(st).includes('fake-pass'));
});

test('flag off: runWithBooks answers 404; flag on: runs the body', async () => {
  let ran = 0;
  const r1 = await runWithBooks(u1, async () => { ran++; return Response.json({ ok: true }); });
  assert.equal(r1.status, 404);
  assert.equal(ran, 0);
  await upsertSetting(u1, 'accounting.enabled', 'true');
  const r2 = await runWithBooks(u1, async () => { ran++; return Response.json({ ok: true }); });
  assert.equal(r2.status, 200);
  assert.equal(ran, 1);
});

test('sync inserts, a re-sync adds nothing, and a pending row that posts is updated in place (no duplicate)', async () => {
  const now = new Date('2026-11-12T20:00:00Z');
  accountsBody = acctBody([
    { id: 'T1', posted: E('2026-11-09'), amount: '-42.10', description: 'COFFEE SHOP' },
    { id: 'T2', posted: 0, amount: '-9.99', description: 'STREAMING', pending: true, transacted_at: E('2026-11-10') },
  ]);
  const s1 = await svc.syncSimpleFin(u1, { fetch: fakeFetch, now });
  assert.deepEqual([s1.inserted, s1.updated, s1.accounts], [2, 0, 1]);
  assert.equal(s1.errors[0].code, 'con.auth'); // surfaced, not swallowed
  assert.match((await svc.connectionStatus(u1)).connection!.errors[0].msg, /Sign in again/);
  const s2 = await svc.syncSimpleFin(u1, { fetch: fakeFetch, now: new Date(now.getTime() + 3600_000) });
  assert.deepEqual([s2.inserted, s2.updated, s2.removed], [0, 0, 0]);
  // the pending charge posts
  accountsBody = acctBody([
    { id: 'T1', posted: E('2026-11-09'), amount: '-42.10', description: 'COFFEE SHOP' },
    { id: 'T2', posted: E('2026-11-11'), amount: '-9.99', description: 'STREAMING' },
  ]);
  const s3 = await svc.syncSimpleFin(u1, { fetch: fakeFetch, now: new Date(now.getTime() + 2 * 3600_000) });
  assert.deepEqual([s3.inserted, s3.updated], [0, 1]);
  const rows = await prisma.bankTransaction.findMany({ where: { userId: u1 }, orderBy: { id: 'asc' } });
  assert.equal(rows.length, 2);
  assert.equal(rows[1].pending, false);
  assert.equal(rows[1].postedDate, '2026-11-11');
  const bal = await prisma.bankAccount.findFirstOrThrow({ where: { userId: u1 } });
  assert.equal(bal.balanceCents, 10000);
});

test('sync respects the manual gap and the encrypted URL is decrypted only in memory', async () => {
  const c = await prisma.bankConnection.findFirstOrThrow({ where: { userId: u1 } });
  await prisma.bankConnection.update({ where: { id: c.id }, data: { lastSyncAt: new Date() } });
  await assert.rejects(svc.syncSimpleFin(u1, { fetch: fakeFetch, manual: true }), /a moment ago/);
});

const OFX = `OFXHEADER:100
DATA:OFXSGML
VERSION:102

<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD
<BANKACCTFROM><BANKID>1<ACCTID>99990001234<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261103<TRNAMT>-25.50<FITID>F1<NAME>GROCERY</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261104<TRNAMT>-5.00<NAME>VENDING</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261104<TRNAMT>-5.00<NAME>VENDING</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

test('OFX upload inserts once; re-upload inserts nothing', async () => {
  const bytes = new TextEncoder().encode(OFX);
  const a = await svc.importOfx(u2, bytes);
  assert.equal(a.inserted, 3);
  const b = await svc.importOfx(u2, bytes);
  assert.deepEqual([b.inserted, b.updated], [0, 0]);
  assert.equal(await prisma.bankTransaction.count({ where: { userId: u2 } }), 3);
  const acct = await prisma.bankAccount.findFirstOrThrow({ where: { userId: u2 } });
  assert.equal(acct.last4, '1234');
  await assert.rejects(svc.importOfx(u2, new Uint8Array(26 * 1024 * 1024)), /larger than/);
  await assert.rejects(svc.importOfx(u2, new TextEncoder().encode('hello')), /OFX/);
});

test('transfer suggestion across two accounts; accept pairs both, ignore and reset work; other users cannot touch rows', async () => {
  const a = await prisma.bankAccount.create({ data: { userId: u2, provider: 'ofx', providerAccountId: 'ofx:aaaa', name: 'Checking' } });
  const b = await prisma.bankAccount.create({ data: { userId: u2, provider: 'ofx', providerAccountId: 'ofx:bbbb', name: 'Savings' } });
  const mk = (accId: number, id: string, amt: number) => prisma.bankTransaction.create({ data: { userId: u2, bankAccountId: accId, providerTxnId: id, source: 'ofx', postedDate: '2026-11-05', amountCents: amt, description: 'XFER' } });
  const t1 = await mk(a.id, 'x1', -77700);
  const t2 = await mk(b.id, 'x2', 77700);
  await svc.runMatching(u2);
  const s1 = await prisma.bankTransaction.findUniqueOrThrow({ where: { id: t1.id } });
  assert.equal(s1.matchStatus, 'suggested');
  await assert.rejects(svc.applyMatchAction(u1, t1.id, { action: 'accept' }), /not found/);
  await svc.applyMatchAction(u2, t1.id, { action: 'accept' });
  const [m1, m2] = await Promise.all([t1.id, t2.id].map(id => prisma.bankTransaction.findUniqueOrThrow({ where: { id } })));
  assert.deepEqual([m1.matchStatus, m2.matchStatus], ['matched', 'matched']);
  assert.deepEqual([m1.matchedTxnId, m2.matchedTxnId], [null, null]); // the old columns are no longer written
  const l1 = await prisma.bankMatch.findMany({ where: { txnId: { in: [t1.id, t2.id] } }, orderBy: { txnId: 'asc' } });
  assert.deepEqual(l1.map(l => [l.txnId, l.kind, l.refId, l.amountCents]), [[t1.id, 'transfer', t2.id, 77700], [t2.id, 'transfer', t1.id, 77700]]);
  await svc.applyMatchAction(u2, t1.id, { action: 'reset' });
  assert.equal(await prisma.bankMatch.count({ where: { txnId: { in: [t1.id, t2.id] } } }), 0);
  assert.equal((await prisma.bankTransaction.findUniqueOrThrow({ where: { id: t2.id } })).matchStatus, 'suggested'); // undone, and offered again
  await svc.applyMatchAction(u2, t2.id, { action: 'ignore' });
  assert.equal((await prisma.bankTransaction.findUniqueOrThrow({ where: { id: t2.id } })).matchStatus, 'ignored');
  // an ignored row is not re-suggested
  await svc.runMatching(u2);
  assert.equal((await prisma.bankTransaction.findUniqueOrThrow({ where: { id: t2.id } })).matchStatus, 'ignored');
});

test('card charge suggests the order; accepting writes a link and, with bank posting off, no journal rows', async () => {
  const card = await prisma.creditCard.create({ data: { userId: u2, name: 'Test card', last4: '4242' } });
  const ord = await prisma.order.create({ data: { userId: u2, platform: 'Amazon', orderNumber: '111-0000000-0000001', orderDate: new Date('2026-11-05T20:00:00Z'), cost: 50, cardId: card.id } });
  const acct = await prisma.bankAccount.create({ data: { userId: u2, provider: 'ofx', providerAccountId: 'ofx:cccc', name: 'Test card', kind: 'credit', last4: '4242' } });
  const t = await prisma.bankTransaction.create({ data: { userId: u2, bankAccountId: acct.id, providerTxnId: 'c1', source: 'ofx', postedDate: '2026-11-06', amountCents: -5000, description: 'AMZN Mktp US' } });
  const journalBefore = await prisma.journalEntry.count({ where: { userId: u2 } });
  await svc.runMatching(u2);
  assert.equal((await prisma.bankTransaction.findUniqueOrThrow({ where: { id: t.id } })).matchStatus, 'suggested');
  await svc.applyMatchAction(u2, t.id, { action: 'accept' });
  const m = await prisma.bankTransaction.findUniqueOrThrow({ where: { id: t.id } });
  assert.equal(m.matchStatus, 'matched');
  assert.equal(m.matchedOrderId, null);
  const link = await prisma.bankMatch.findFirstOrThrow({ where: { txnId: t.id } });
  assert.deepEqual([link.kind, link.refId, link.amountCents], ['order_charge', ord.id, 5000]);
  assert.equal(await prisma.journalEntry.count({ where: { userId: u2 } }), journalBefore);
});

// ---- P3: links, posting, reconcile, lock gate ----
let u3 = 0;
const DAY = '2027-02-10';
async function setup3() {
  u3 = (await prisma.user.create({ data: { name: 'three' } })).id;
  await upsertSetting(u3, 'accounting.enabled', 'true');
  await upsertSetting(u3, 'accounting.goLive', '2027-01-01');
  const la = await prisma.ledgerAccount.create({ data: { userId: u3, code: '1010', name: 'Checking', type: 'asset', business: 'shared' } });
  const mapped = await prisma.bankAccount.create({ data: { userId: u3, provider: 'ofx', providerAccountId: 'ofx:m3', name: 'Mapped checking', ledgerAccountId: la.id } });
  const unmapped = await prisma.bankAccount.create({ data: { userId: u3, provider: 'ofx', providerAccountId: 'ofx:p3', name: 'Personal account' } });
  const row = (bankAccountId: number, id: string, amountCents: number, postedDate = DAY) =>
    prisma.bankTransaction.create({ data: { userId: u3, bankAccountId, providerTxnId: id, source: 'ofx', postedDate, amountCents, description: `made up ${id}` } });
  return { la, mapped, unmapped, row };
}
const liveBank = (userId: number) => prisma.journalEntry.findMany({ where: { userId, sourceKey: { startsWith: 'bank:' }, reversedAt: null, source: 'bank' }, include: { lines: true } });

test('migration SQL copies today refs into links (order, transfer, ignored) and leaves the old columns', async () => {
  const uu = (await prisma.user.create({ data: { name: 'legacy' } })).id;
  const acc = await prisma.bankAccount.create({ data: { userId: uu, provider: 'ofx', providerAccountId: 'ofx:legacy', name: 'Old' } });
  const mk = (id: string, amt: number, extra: Record<string, unknown>) =>
    prisma.bankTransaction.create({ data: { userId: uu, bankAccountId: acc.id, providerTxnId: id, source: 'ofx', postedDate: '2026-11-01', amountCents: amt, description: id, ...extra } });
  const a = await mk('l1', -2500, { matchStatus: 'matched', matchedOrderId: 42 });
  const b = await mk('l2', -900, { matchStatus: 'matched', matchedTxnId: 4321 });
  const c = await mk('l3', -100, { matchStatus: 'ignored' });
  await mk('l4', -100, { matchStatus: 'unmatched' });
  const { readFileSync } = await import('node:fs');
  const sql = readFileSync(path.join(process.cwd(), 'prisma/migrations/20261117000000_bank_match_statement_balance/migration.sql'), 'utf8');
  const copy = sql.slice(sql.indexOf('-- Copy today')).split(';').map(x => x.replace(/^--.*$/gm, '').trim()).filter(Boolean);
  assert.equal(copy.length, 3);
  const before = await prisma.bankMatch.count({ where: { userId: uu } });
  for (const stmt of copy) await prisma.$executeRawUnsafe(`${stmt} AND "userId" = ${uu}`); // scoped: other tests' rows already have links
  assert.equal(before, 0);
  const links = await prisma.bankMatch.findMany({ where: { userId: uu }, orderBy: { txnId: 'asc' } });
  assert.deepEqual(links.map(l => [l.txnId, l.kind, l.refId, l.amountCents]), [[a.id, 'order_charge', 42, 2500], [b.id, 'transfer', 4321, 900], [c.id, 'ignore', 0, 100]]);
  assert.equal((await prisma.bankTransaction.findUniqueOrThrow({ where: { id: a.id } })).matchedOrderId, 42);
});

test('link sums are enforced: a row cannot be linked for more or less than its amount', async () => {
  const { mapped, row } = await setup3();
  const t = await row(mapped.id, 'sum1', -5000);
  await assert.rejects(svc.writeLinks(t.id, u3, [{ txnId: t.id, kind: 'order_charge', refId: 1, amountCents: 4000 }], 'matched'), /add up/);
  await assert.rejects(svc.writeLinks(t.id, u3, [{ txnId: t.id, kind: 'order_charge', refId: 1, amountCents: 3000 }, { txnId: t.id, kind: 'cost', refId: 2, amountCents: 3000 }], 'matched'), /add up/);
  await assert.rejects(svc.writeLinks(t.id, u3, [{ txnId: t.id, kind: 'order_charge', refId: 1, amountCents: 3000 }, { txnId: t.id, kind: 'order_charge', refId: 2, amountCents: 2000 }], 'matched'), /one order/);
  assert.equal(await prisma.bankMatch.count({ where: { txnId: t.id } }), 0);
  await svc.writeLinks(t.id, u3, [{ txnId: t.id, kind: 'order_charge', refId: 1, amountCents: 3000 }, { txnId: t.id, kind: 'cost', refId: 2, amountCents: 2000 }], 'matched');
  assert.equal(await prisma.bankMatch.count({ where: { txnId: t.id } }), 2);
  await assert.rejects(prisma.bankMatch.create({ data: { userId: u3, txnId: t.id, kind: 'order_charge', refId: 1, amountCents: 1 } }), /Unique/i); // one link per (row, kind, ref)
});

test('link by hand: by order number or #id; an order takes charges until paid, then refuses; undoing one charge keeps the others', async () => {
  const { mapped, row } = await setup3();
  const o = await prisma.order.create({ data: { userId: u3, platform: 'Acme', orderNumber: 'MADEUP-100', orderDate: new Date('2027-02-05T20:00:00Z'), cost: 100, subtotalAmount: 100, taxAmount: 0 } });
  const a = await row(mapped.id, 'lh1', -4000);
  const b = await row(mapped.id, 'lh2', -6000);
  const c = await row(mapped.id, 'lh3', -500);
  await assert.rejects(svc.applyMatchAction(u3, a.id, { action: 'link', orderNumber: 'NOPE-1' }), /no order has/);
  await svc.applyMatchAction(u3, a.id, { action: 'link', orderNumber: ' MADEUP-100 ' });
  await svc.applyMatchAction(u3, b.id, { action: 'link', orderId: o.id });
  await assert.rejects(svc.applyMatchAction(u3, c.id, { action: 'link', orderId: o.id }), /paid in full/);
  await assert.rejects(svc.applyMatchAction(u3, a.id, { action: 'link', orderId: o.id }), /already linked/);
  const links = await prisma.bankMatch.findMany({ where: { userId: u3, kind: 'order_charge', refId: o.id }, orderBy: { txnId: 'asc' } });
  assert.deepEqual(links.map(l => [l.txnId, l.amountCents]), [[a.id, 4000], [b.id, 6000]]);
  await svc.applyMatchAction(u3, a.id, { action: 'reset' });
  assert.equal((await prisma.bankTransaction.findUniqueOrThrow({ where: { id: a.id } })).matchStatus, 'unmatched');
  assert.equal((await prisma.bankTransaction.findUniqueOrThrow({ where: { id: b.id } })).matchStatus, 'matched');
  assert.equal(await prisma.bankMatch.count({ where: { txnId: b.id, kind: 'order_charge' } }), 1);
  await svc.applyMatchAction(u3, c.id, { action: 'link', orderId: o.id }); // part paid again: room for it
});

test('a card charge is refused for an order on another card', async () => {
  const { row } = await setup3();
  const c1 = await prisma.creditCard.create({ data: { userId: u3, name: 'Card one', last4: '1111' } });
  const c2 = await prisma.creditCard.create({ data: { userId: u3, name: 'Card two', last4: '2222' } });
  const acct = await prisma.bankAccount.create({ data: { userId: u3, provider: 'ofx', providerAccountId: 'ofx:c1', name: 'Card one', kind: 'credit', creditCardId: c1.id } });
  const o = await prisma.order.create({ data: { userId: u3, platform: 'Acme', orderDate: new Date('2027-02-05T20:00:00Z'), cost: 20, cardId: c2.id } });
  const t = await row(acct.id, 'oc1', -2000);
  await assert.rejects(svc.applyMatchAction(u3, t.id, { action: 'link', orderId: o.id }), /different card/);
});

test('a refund can arrive in parts: two credits fill a return, a third is refused', async () => {
  const { mapped, row } = await setup3();
  const o = await prisma.order.create({ data: { userId: u3, platform: 'Acme', orderNumber: 'MADEUP-200', orderDate: new Date('2027-02-01T20:00:00Z'), cost: 45 } });
  const r = await prisma.orderReturn.create({ data: { orderId: o.id, itemName: 'made up item', status: 'refunded', refundAmount: 45, refundedAt: new Date('2027-02-08T20:00:00Z') } });
  const a = await row(mapped.id, 'pr1', 2000);
  const b = await row(mapped.id, 'pr2', 2500);
  const c = await row(mapped.id, 'pr3', 100);
  await svc.applyMatchAction(u3, a.id, { action: 'link', orderNumber: 'MADEUP-200' }); // the order's only return
  await svc.applyMatchAction(u3, c.id, { action: 'link', returnId: r.id }); // 2100 of 4500
  await assert.rejects(svc.applyMatchAction(u3, b.id, { action: 'link', returnId: r.id }), /more than what is left/); // 4600
  await svc.applyMatchAction(u3, c.id, { action: 'reset' });
  await svc.applyMatchAction(u3, b.id, { action: 'link', returnId: r.id });
  await assert.rejects(svc.applyMatchAction(u3, c.id, { action: 'link', returnId: r.id }), /more than what is left/);
  const sum = await prisma.bankMatch.aggregate({ where: { userId: u3, kind: 'order_refund', refId: r.id }, _sum: { amountCents: true } });
  assert.equal(sum._sum.amountCents, 4500);
});

test('mark several rows Personal at once; rows already linked are skipped', async () => {
  const { mapped, row } = await setup3();
  const a = await row(mapped.id, 'mp1', -100);
  const b = await row(mapped.id, 'mp2', -200);
  const done = await row(mapped.id, 'mp3', -300);
  await svc.applyMatchAction(u3, done.id, { action: 'personal' });
  const r = await svc.markPersonal(u3, [a.id, b.id, done.id]);
  assert.deepEqual(r, { ok: true, marked: 2, skipped: 1 });
  const links = await prisma.bankMatch.findMany({ where: { userId: u3, kind: 'personal' }, orderBy: { txnId: 'asc' } });
  assert.deepEqual(links.map(l => [l.txnId, l.amountCents]), [[a.id, 100], [b.id, 200], [done.id, 300]]);
  assert.equal((await svc.markPersonal(u2, [a.id])).marked, 0); // another user's rows are not touched
});

test('Personal posts on a mapped account, Ignore is refused there (duplicate allowed, posts nothing), unmapped Ignore is fine', async () => {
  const { mapped, unmapped, row, la } = await setup3();
  const post = await import('./posting.ts');
  const svc2 = await import('../service.ts');
  const spend = await row(mapped.id, 'p1', -1234);
  const dup = await row(mapped.id, 'p2', -500);
  const away = await row(unmapped.id, 'p3', -700);
  // bank posting off: the link is made, nothing posts
  await svc.applyMatchAction(u3, spend.id, { action: 'personal' });
  assert.equal((await liveBank(u3)).length, 0);
  assert.equal(await prisma.bankMatch.count({ where: { txnId: spend.id, kind: 'personal' } }), 1);
  // bank posting on: one balanced entry (draw), and a second run adds nothing
  await upsertSetting(u3, 'accounting.bankPosting', 'true');
  assert.equal(await post.bankPostingEnabled(u3), true);
  const r1 = await svc2.runReconcile(u3);
  assert.equal(r1.bank?.posted, 1);
  const e = await liveBank(u3);
  assert.equal(e.length, 1);
  assert.equal(e[0].sourceKey, `bank:${spend.id}`);
  assert.equal(e[0].lines.reduce((s, l) => s + l.amountCents, 0), 0);
  assert.equal(e[0].lines.find(l => l.accountId === la.id)?.amountCents, -1234);
  const r2 = await svc2.runReconcile(u3);
  assert.deepEqual([r2.bank?.posted, r2.bank?.reversed], [0, 0]);
  // Ignore on a mapped account is refused; as a duplicate it is allowed and posts nothing
  await assert.rejects(svc.applyMatchAction(u3, dup.id, { action: 'ignore' }), /in your books/);
  assert.equal((await prisma.bankTransaction.findUniqueOrThrow({ where: { id: dup.id } })).matchStatus, 'unmatched');
  await svc.applyMatchAction(u3, dup.id, { action: 'ignore', duplicate: true });
  await svc.applyMatchAction(u3, away.id, { action: 'ignore' });
  assert.equal((await liveBank(u3)).length, 1);
  // undo: the entry is reversed
  await svc.applyMatchAction(u3, spend.id, { action: 'reset' });
  assert.equal((await liveBank(u3)).length, 0);
  assert.equal(await prisma.journalEntry.count({ where: { userId: u3, source: 'reversal', sourceKey: `bank:${spend.id}` } }), 1);
});

test('lock gate: a month that does not tie is refused; Lock anyway needs a reason and writes an audit row', async () => {
  const { mapped, row } = await setup3();
  const post = await import('./posting.ts');
  await upsertSetting(u3, 'accounting.bankPosting', 'true');
  const t = await row(mapped.id, 'g1', -2000, '2027-02-12'); // an open row, no statement balance
  const gate = await post.lockGate(u3, '2027-02', '2027-01-01');
  assert.equal(gate.ok, false);
  const refused = await post.lockMonth(u3, '2027-02', '2027-01-01');
  assert.equal(refused.ok, false);
  assert.equal(await prisma.periodLock.count({ where: { userId: u3 } }), 0);
  const noReason = await post.lockMonth(u3, '2027-02', '2027-01-01', { force: true, reason: '   ' });
  assert.equal(noReason.ok, false);
  const forced = await post.lockMonth(u3, '2027-02', '2027-01-01', { force: true, reason: 'statement not downloaded yet' });
  assert.deepEqual(forced, { ok: true, forced: true });
  assert.equal(await prisma.periodLock.count({ where: { userId: u3, month: '2027-02' } }), 1);
  const audit = await prisma.auditLog.findFirstOrThrow({ where: { userId: u3, action: 'lock_anyway' } });
  assert.equal(audit.entityId, '2027-02');
  assert.match(audit.after ?? '', /statement not downloaded yet/);
  // after linking the row and typing a matching statement balance, another month ties and locks without force
  await svc.applyMatchAction(u3, t.id, { action: 'personal' });
  await svc.setManualBalance(u3, mapped.id, '2027-03-31', -2000);
  await (await import('../service.ts')).runReconcile(u3);
  const g3 = await post.lockGate(u3, '2027-03', '2027-01-01');
  assert.equal(g3.ok, true, JSON.stringify(g3));
  assert.deepEqual(await post.lockMonth(u3, '2027-03', '2027-01-01'), { ok: true, forced: false });
  void t;
});

test('bank posting off: the lock gate is skipped, and turning it off reverses what was posted', async () => {
  const { mapped, row } = await setup3();
  const post = await import('./posting.ts');
  const svc2 = await import('../service.ts');
  await row(mapped.id, 'off1', -900, '2027-04-10'); // an open row that would fail the gate
  const g = await post.lockGate(u3, '2027-04', '2027-01-01');
  assert.equal(g.ok, true);
  assert.equal(g.skipped, 'bank posting is off');
  const t = await row(mapped.id, 'off2', -300, '2027-04-11');
  await upsertSetting(u3, 'accounting.bankPosting', 'true');
  await svc.applyMatchAction(u3, t.id, { action: 'personal' });
  assert.equal((await liveBank(u3)).length, 1);
  await upsertSetting(u3, 'accounting.bankPosting', 'false');
  const r = await svc2.runReconcile(u3);
  assert.deepEqual([r.bank.posted, r.bank.reversed], [0, 1]);
  assert.equal((await liveBank(u3)).length, 0);
  const again = await svc2.runReconcile(u3);
  assert.deepEqual([again.bank.posted, again.bank.reversed], [0, 0]);
});

test('a link whose month is locked posts on the first open day after it', async () => {
  const { mapped, row } = await setup3();
  await upsertSetting(u3, 'accounting.bankPosting', 'true');
  await prisma.periodLock.create({ data: { userId: u3, month: '2027-02' } });
  const t = await row(mapped.id, 'lk1', -800, '2027-02-14');
  await svc.applyMatchAction(u3, t.id, { action: 'personal' });
  const e = await liveBank(u3);
  assert.equal(e.length, 1);
  assert.equal(e[0].date, '2027-03-01');
  assert.match(e[0].memo, /dated 2027-02-14/);
});

// ---- P3d: rules, cost entries from rows, cashback credits ----
const liveCost = (userId: number) => prisma.journalEntry.findMany({ where: { userId, source: 'cost', reversedAt: null }, include: { lines: true } });

test('a rule links matching open rows at once (matchedBy rule:<id>, hits counted); Undo sticks; a bad regex is refused and one stored anyway never throws', async () => {
  const { mapped, row } = await setup3();
  const t1 = await row(mapped.id, 'r1', -1500, '2027-02-10'); // description: "made up r1"
  const t2 = await row(mapped.id, 'r2', -700, '2027-02-11');
  await assert.rejects(svc.createRule(u3, { pattern: '(', isRegex: true, action: 'personal' }), /regular expression/);
  await assert.rejects(svc.createRule(u3, { pattern: 'made', action: 'ignore-ish' }), /unknown action/);
  await assert.rejects(svc.createRule(u3, { pattern: 'made', action: 'cost' }), /category/);
  await prisma.matchRule.create({ data: { userId: u3, pattern: '(', isRegex: true, action: 'personal' } }); // stored broken: never matches, never throws
  const rule = await svc.createRule(u3, { pattern: 'MADE UP R', sign: 'debit', maxCents: 1000, action: 'personal' });
  const a = await prisma.bankTransaction.findUniqueOrThrow({ where: { id: t1.id } });
  const b = await prisma.bankTransaction.findUniqueOrThrow({ where: { id: t2.id } });
  assert.equal(a.matchStatus, 'unmatched'); // over the max
  assert.equal(b.matchStatus, 'matched');
  const link = await prisma.bankMatch.findFirstOrThrow({ where: { txnId: t2.id } });
  assert.deepEqual([link.kind, link.matchedBy, link.amountCents], ['personal', `rule:${rule.id}`, 700]);
  assert.equal((await prisma.matchRule.findUniqueOrThrow({ where: { id: rule.id } })).hits, 1);
  // Undo: the row stays out of the rules even after a re-run
  await svc.applyMatchAction(u3, t2.id, { action: 'reset' });
  await svc.runMatching(u3);
  assert.equal((await prisma.bankTransaction.findUniqueOrThrow({ where: { id: t2.id } })).matchStatus, 'unmatched');
  assert.equal((await prisma.matchRule.findUniqueOrThrow({ where: { id: rule.id } })).hits, 1);
  // disabled rules do nothing; delete works and is per user
  await svc.updateRule(u3, rule.id, { enabled: false, maxCents: null });
  await svc.runMatching(u3);
  assert.equal((await prisma.bankTransaction.findUniqueOrThrow({ where: { id: t1.id } })).matchStatus, 'unmatched');
  await assert.rejects(svc.deleteRule(u1, rule.id), /not found/);
  await svc.deleteRule(u3, rule.id);
  assert.equal(await prisma.matchRule.count({ where: { id: rule.id } }), 0);
});

test('rules: ignore acts on an unmapped account only; a clean transfer pair is left to the built-in rule; darkbloom posts Dr cash, Cr 1500', async () => {
  const { mapped, unmapped, row, la } = await setup3();
  await upsertSetting(u3, 'accounting.bankPosting', 'true');
  const svc2 = await import('../service.ts');
  const mine = await row(mapped.id, 'ig1', -300, '2027-02-10');
  const away = await row(unmapped.id, 'ig2', -300, '2027-02-10');
  await svc.createRule(u3, { pattern: 'made up ig', action: 'ignore' });
  assert.equal((await prisma.bankTransaction.findUniqueOrThrow({ where: { id: mine.id } })).matchStatus, 'unmatched');
  assert.equal((await prisma.bankTransaction.findUniqueOrThrow({ where: { id: away.id } })).matchStatus, 'ignored');
  // transfer_to: the built-in transfer pairing claims a clean pair first, so the rule stays out of it
  const out = await row(mapped.id, 'tx1', -5000, '2027-02-12');
  const inn = await row(unmapped.id, 'tx2', 5000, '2027-02-13');
  await svc.createRule(u3, { pattern: 'made up tx1', action: `transfer_to:${unmapped.id}` });
  assert.equal((await prisma.bankTransaction.findUniqueOrThrow({ where: { id: out.id } })).matchStatus, 'suggested');
  assert.equal(await prisma.bankMatch.count({ where: { txnId: { in: [out.id, inn.id] } } }), 0);
  // darkbloom
  const pay = await row(mapped.id, 'db1', 9000, '2027-02-14');
  await svc.createRule(u3, { pattern: 'made up db1', action: 'darkbloom' });
  await svc2.runReconcile(u3);
  const e = await liveBank(u3);
  const dbEntry = e.find(x => x.sourceKey === `bank:${pay.id}`)!;
  assert.equal(dbEntry.lines.reduce((s, l) => s + l.amountCents, 0), 0);
  assert.equal(dbEntry.lines.find(l => l.accountId === la.id)?.amountCents, 9000);
  const key1500 = await prisma.ledgerAccount.findFirstOrThrow({ where: { userId: u3, systemKey: 'darkbloom_balance' } });
  assert.equal(dbEntry.lines.find(l => l.accountId === key1500.id)?.amountCents, -9000);
  const again = await svc2.runReconcile(u3);
  assert.deepEqual([again.bank.posted, again.bank.reversed], [0, 0]);
});

test('make a cost entry: a debit on a mapped account becomes a cost, the row links as cost and posts nothing; Undo voids the cost', async () => {
  const { mapped, unmapped, row } = await setup3();
  const svc2 = await import('../service.ts');
  await upsertSetting(u3, 'accounting.bankPosting', 'true');
  const t = await row(mapped.id, 'c1', -2500, '2027-02-10');
  await assert.rejects(svc.applyMatchAction(u3, t.id, { action: 'cost', category: 'nonsense' }), /category/);
  await svc.applyMatchAction(u3, t.id, { action: 'cost', category: 'postage' });
  const link = await prisma.bankMatch.findFirstOrThrow({ where: { txnId: t.id } });
  assert.equal(link.kind, 'cost');
  const cost = await prisma.costEntry.findUniqueOrThrow({ where: { id: link.refId } });
  assert.deepEqual([cost.amountCents, cost.date, cost.category, cost.business, cost.vendor], [2500, '2027-02-10', 'postage', 'resell', 'made up c1']);
  assert.equal((await liveCost(u3)).length, 1); // the cost posts the expense
  assert.equal((await liveBank(u3)).length, 0); // the bank row posts nothing
  assert.equal((await svc2.runReconcile(u3)).costs.posted, 0);
  await svc.applyMatchAction(u3, t.id, { action: 'reset' });
  assert.equal((await prisma.costEntry.findUniqueOrThrow({ where: { id: cost.id } })).voidedAt != null, true);
  assert.equal((await liveCost(u3)).length, 0);
  // a credit, and a row on an account that is not in the books, cannot become a cost
  const inflow = await row(mapped.id, 'c2', 400, '2027-02-11');
  await assert.rejects(svc.applyMatchAction(u3, inflow.id, { action: 'cost', category: 'postage' }), /debit/);
  const away = await row(unmapped.id, 'c3', -400, '2027-02-11');
  await assert.rejects(svc.applyMatchAction(u3, away.id, { action: 'cost', category: 'postage' }), /not in your books/);
  assert.equal(await prisma.costEntry.count({ where: { userId: u3 } }), 1);
  // a cost rule does the same without asking
  await svc.createRule(u3, { pattern: 'made up c2x', action: 'cost', costCategory: 'software' });
  const r = await row(mapped.id, 'c2x', -1100, '2027-02-12');
  await svc.runMatching(u3);
  const l2 = await prisma.bankMatch.findFirstOrThrow({ where: { txnId: r.id } });
  assert.deepEqual([l2.kind, l2.matchedBy.startsWith('rule:')], ['cost', true]);
  assert.equal((await liveCost(u3)).length, 1);
});

test('card cashback credit: suggested, accepted as a link, posts Dr card / Cr receivable once; an exact single order is only auto-accepted when autoMatch is on', async () => {
  const { row } = await setup3();
  const svc2 = await import('../service.ts');
  await upsertSetting(u3, 'accounting.bankPosting', 'true');
  const card = await prisma.creditCard.create({ data: { userId: u3, name: 'Cashback card', last4: '5555' } });
  const cardAcct = await prisma.bankAccount.create({ data: { userId: u3, provider: 'ofx', providerAccountId: 'ofx:cb', name: 'Cashback card', kind: 'credit', last4: '5555', creditCardId: card.id } });
  const mk = (num: string, cashbackAmount: number, amexOfferDollars: number | null = null) =>
    prisma.order.create({ data: { userId: u3, platform: 'Acme', orderNumber: num, orderDate: new Date('2027-02-03T20:00:00Z'), cost: 100, cardId: card.id, cashbackAmount, amexOfferDollars } });
  const o1 = await mk('A-1', 5);
  await mk('A-2', 3, 4);
  const credit = await row(cardAcct.id, 'cb1', 500, '2027-03-02');
  await svc.runMatching(u3);
  const t = await prisma.bankTransaction.findUniqueOrThrow({ where: { id: credit.id } });
  assert.equal(t.matchStatus, 'suggested');
  assert.equal(JSON.parse(t.suggestion!).kind, 'cashback');
  assert.equal(await prisma.bankMatch.count({ where: { txnId: credit.id } }), 0); // autoMatch is off: never linked by itself
  await svc.applyMatchAction(u3, credit.id, { action: 'accept' });
  const link = await prisma.bankMatch.findFirstOrThrow({ where: { txnId: credit.id } });
  assert.deepEqual([link.kind, link.refId, link.amountCents, link.note, link.matchedBy], ['cashback', o1.id, 500, 'cb=500', 'user']);
  const e = (await liveBank(u3)).find(x => x.sourceKey === `bank:${credit.id}`)!;
  assert.equal(e.lines.reduce((s, l) => s + l.amountCents, 0), 0);
  const recvAcct = await prisma.ledgerAccount.findFirstOrThrow({ where: { userId: u3, systemKey: 'cashback_card_recv' } });
  assert.equal(e.lines.find(l => l.accountId === recvAcct.id)?.amountCents, -500);
  const r2 = await svc2.runReconcile(u3);
  assert.deepEqual([r2.bank.posted, r2.bank.reversed], [0, 0]);
  // order 1 is cleared: the same amount is no longer offered; order 2 (3 + 4) is the open one
  const again = await row(cardAcct.id, 'cb2', 500, '2027-03-03');
  await svc.runMatching(u3);
  assert.equal((await prisma.bankTransaction.findUniqueOrThrow({ where: { id: again.id } })).matchStatus, 'unmatched');
  const both = await row(cardAcct.id, 'cb3', 700, '2027-03-03');
  await svc.runMatching(u3);
  assert.equal((await prisma.bankTransaction.findUniqueOrThrow({ where: { id: both.id } })).matchStatus, 'suggested');
  // with autoMatch on, the exact single-order credit links itself, badge-able as auto:cashback, and Undo still works
  await upsertSetting(u3, 'accounting.autoMatch', 'true');
  await svc.runMatching(u3);
  const auto = await prisma.bankMatch.findFirstOrThrow({ where: { txnId: both.id } });
  assert.deepEqual([auto.note, auto.matchedBy], ['cb=300,ax=400', 'auto:cashback']);
  await svc.applyMatchAction(u3, both.id, { action: 'reset' });
  assert.equal(await prisma.bankMatch.count({ where: { txnId: both.id } }), 0);
  await svc.runMatching(u3);
  assert.equal(await prisma.bankMatch.count({ where: { txnId: both.id } }), 0); // undone auto match is not redone
  await upsertSetting(u3, 'accounting.autoMatch', 'false');
});

test('portal cashback: only a rule marks the credit; it is suggested against portal receivables and posts Dr cash, Cr 1310', async () => {
  const { mapped, row, la } = await setup3();
  await upsertSetting(u3, 'accounting.bankPosting', 'true');
  const o = await prisma.order.create({ data: { userId: u3, platform: 'Acme', orderNumber: 'P-1', orderDate: new Date('2027-01-20T20:00:00Z'), cost: 100, portalCashback: 6 } });
  const pay = await row(mapped.id, 'por1', 600, '2027-03-05');
  await svc.runMatching(u3);
  assert.equal((await prisma.bankTransaction.findUniqueOrThrow({ where: { id: pay.id } })).matchStatus, 'unmatched'); // no rule, no portal guess
  await svc.createRule(u3, { pattern: 'made up por', sign: 'credit', action: 'cashback_portal' });
  const t = await prisma.bankTransaction.findUniqueOrThrow({ where: { id: pay.id } });
  assert.equal(t.matchStatus, 'suggested');
  assert.equal(await prisma.bankMatch.count({ where: { txnId: pay.id } }), 0);
  await svc.applyMatchAction(u3, pay.id, { action: 'accept' });
  const link = await prisma.bankMatch.findFirstOrThrow({ where: { txnId: pay.id } });
  assert.deepEqual([link.kind, link.refId, link.note], ['cashback', o.id, 'portal']);
  const e = (await liveBank(u3)).find(x => x.sourceKey === `bank:${pay.id}`)!;
  const r1310 = await prisma.ledgerAccount.findFirstOrThrow({ where: { userId: u3, systemKey: 'cashback_portal_recv' } });
  assert.equal(e.lines.find(l => l.accountId === la.id)?.amountCents, 600);
  assert.equal(e.lines.find(l => l.accountId === r1310.id)?.amountCents, -600);
});
