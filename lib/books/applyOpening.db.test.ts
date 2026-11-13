// DB-level test of applyOpening against a real SQLite file (Prisma migrations applied to a temp DB).
// Run with `npm run test:books-db` (needs `prisma generate` done); not part of `npm test` because it loads the
// app's server modules through lib/books/testsupport/alias-register.mjs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'books-db-'));
process.env.DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
execFileSync('npx', ['prisma', 'migrate', 'deploy'], { env: process.env, stdio: 'pipe' });

const { prisma } = await import('../db.ts');
const { applyOpening, seedChart, readOpeningInput } = await import('./service.ts');
const { PrismaStore } = await import('./prismaStore.ts');
const { bankAccountIds, EMPTY_OPENING } = await import('./opening.ts');

let u1 = 0, u2 = 0, bank1 = 0, bank2 = 0;
const audit = (userId: number, n: number) => ({
  userId, actor: `user:${userId}`, action: 'opening', entity: 'Opening', entityId: 'opening', before: '{}', after: JSON.stringify({ n }),
});
const counts = async (userId: number) => ({
  audit: await prisma.auditLog.count({ where: { userId } }),
  entries: await prisma.journalEntry.count({ where: { userId } }),
  setting: await prisma.setting.count({ where: { userId, key: 'accounting.openingInput' } }),
});

before(async () => {
  u1 = (await prisma.user.create({ data: { name: 'one' } })).id;
  u2 = (await prisma.user.create({ data: { name: 'two' } })).id;
  for (const u of [u1, u2]) await seedChart(new PrismaStore(), u);
  bank1 = (await prisma.ledgerAccount.create({ data: { userId: u1, code: '1000', name: 'Checking', type: 'asset', business: 'shared' } })).id;
  bank2 = (await prisma.ledgerAccount.create({ data: { userId: u2, code: '1000', name: 'Other checking', type: 'asset', business: 'shared' } })).id;
});
after(async () => { await prisma.$disconnect(); rmSync(dir, { recursive: true, force: true }); });

test('applyOpening writes the opening entry, the saved input and the audit row, and a second apply is idempotent', async () => {
  const input = { ...EMPTY_OPENING, banks: [{ accountId: bank1, cents: 123400 }], darkbloomCents: 5000 };
  const r1 = await applyOpening(u1, input, new Date('2027-01-02T12:00:00Z'), audit(u1, 1));
  assert.deepEqual(r1.errors, []);
  assert.equal(r1.posted, 1);
  const c1 = await counts(u1);
  assert.deepEqual(c1, { audit: 1, entries: 1, setting: 1 });
  assert.deepEqual((await readOpeningInput(u1)).banks, [{ accountId: bank1, cents: 123400 }]);
  // same input again: nothing new in the journal, still one saved input, a second audit row (every apply is audited)
  const r2 = await applyOpening(u1, input, new Date('2027-01-03T12:00:00Z'), audit(u1, 2));
  assert.equal(r2.posted, 0);
  assert.equal(r2.reversed, 0);
  assert.deepEqual(await counts(u1), { audit: 2, entries: 1, setting: 1 });
  // changed input: the old entry is reversed (append-only) and a new one posted
  const r3 = await applyOpening(u1, { ...input, banks: [{ accountId: bank1, cents: 99900 }] }, new Date('2027-01-04T12:00:00Z'), audit(u1, 3));
  assert.deepEqual([r3.posted, r3.reversed], [1, 1]);
  assert.equal((await counts(u1)).setting, 1);
  const live = await prisma.journalEntry.count({ where: { userId: u1, reversedAt: null, source: { not: 'reversal' } } });
  assert.equal(live, 1);
});

test('the audit row and the saved input commit together: a failing audit write rolls the input back', async () => {
  const before = await counts(u2);
  const bad = { ...audit(u2, 9), actor: null as unknown as string }; // actor is required: the audit insert throws inside the transaction
  await assert.rejects(applyOpening(u2, { ...EMPTY_OPENING, darkbloomCents: 700 }, new Date('2027-01-02T12:00:00Z'), bad));
  const after = await counts(u2);
  assert.equal(after.setting, before.setting);
  assert.equal(after.audit, before.audit);
});

test('opening bank ids outside the user\'s own accounts are rejected', async () => {
  // the route\'s check: the user\'s account list, narrowed to bank accounts
  const mine = bankAccountIds(await new PrismaStore().listAccounts(u1));
  assert.ok(mine.has(bank1));
  assert.ok(!mine.has(bank2), 'another user\'s bank account id must not qualify');
  // and the store itself refuses to resolve another user\'s account id, so applyOpening cannot post to it
  const b = await counts(u1);
  const r = await applyOpening(u1, { ...EMPTY_OPENING, banks: [{ accountId: bank2, cents: 5000 }] }, new Date('2027-01-05T12:00:00Z'), audit(u1, 4)).then(x => ({ ok: true as const, x }), e => ({ ok: false as const, e }));
  const a = await counts(u1);
  const foreignLines = await prisma.journalLine.count({ where: { accountId: bank2 } });
  assert.equal(foreignLines, 0, 'no journal line may land on another user\'s account');
  if (r.ok) assert.ok(r.x.errors.length > 0, 'a foreign bank id must surface as an error');
  else assert.match(String(r.e), /unknown account id/);
  void b; void a;
});

test('buyer account names are only read for buyers that have an order of this user', async () => {
  const buyer = await prisma.buyer.create({ data: { name: 'Secret Buyer' } });
  await prisma.order.create({ data: { userId: u2, platform: 'x', orderDate: new Date('2027-01-02'), cost: 1, buyerId: buyer.id } });
  const st = new PrismaStore();
  const mine = await st.resolveAccount(u2, `buyer:${buyer.id}`);
  assert.ok(mine.name.includes('Secret Buyer'), 'the owner of an order for this buyer gets the name');
  const theirs = await st.resolveAccount(u1, `buyer:${buyer.id}`);
  assert.ok(!theirs.name.includes('Secret Buyer'), 'user 1 has no order for this buyer: its name stays out of user 1\'s chart');
});
