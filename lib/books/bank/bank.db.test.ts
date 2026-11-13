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
  assert.deepEqual([m1.matchStatus, m1.matchedTxnId, m2.matchStatus, m2.matchedTxnId], ['matched', t2.id, 'matched', t1.id]);
  await svc.applyMatchAction(u2, t1.id, { action: 'reset' });
  assert.equal((await prisma.bankTransaction.findUniqueOrThrow({ where: { id: t2.id } })).matchStatus, 'unmatched');
  await svc.applyMatchAction(u2, t2.id, { action: 'ignore' });
  assert.equal((await prisma.bankTransaction.findUniqueOrThrow({ where: { id: t2.id } })).matchStatus, 'ignored');
  // an ignored row is not re-suggested
  await svc.runMatching(u2);
  assert.equal((await prisma.bankTransaction.findUniqueOrThrow({ where: { id: t2.id } })).matchStatus, 'ignored');
});

test('card charge suggests the order; accepting only changes matchStatus (no journal rows)', async () => {
  const card = await prisma.creditCard.create({ data: { userId: u2, name: 'Test card', last4: '4242' } });
  const ord = await prisma.order.create({ data: { userId: u2, platform: 'Amazon', orderNumber: '111-0000000-0000001', orderDate: new Date('2026-11-05T20:00:00Z'), cost: 50, cardId: card.id } });
  const acct = await prisma.bankAccount.create({ data: { userId: u2, provider: 'ofx', providerAccountId: 'ofx:cccc', name: 'Test card', kind: 'credit', last4: '4242' } });
  const t = await prisma.bankTransaction.create({ data: { userId: u2, bankAccountId: acct.id, providerTxnId: 'c1', source: 'ofx', postedDate: '2026-11-06', amountCents: -5000, description: 'AMZN Mktp US' } });
  const journalBefore = await prisma.journalEntry.count({ where: { userId: u2 } });
  await svc.runMatching(u2);
  assert.equal((await prisma.bankTransaction.findUniqueOrThrow({ where: { id: t.id } })).matchStatus, 'suggested');
  await svc.applyMatchAction(u2, t.id, { action: 'accept' });
  const m = await prisma.bankTransaction.findUniqueOrThrow({ where: { id: t.id } });
  assert.deepEqual([m.matchStatus, m.matchedOrderId], ['matched', ord.id]);
  assert.equal(await prisma.journalEntry.count({ where: { userId: u2 } }), journalBefore);
});
