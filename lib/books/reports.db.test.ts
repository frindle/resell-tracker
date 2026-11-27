// P4 against a real SQLite file (migrations applied): the Form1099K table, and the reports reading lines from the Prisma
// store after a real reconcile. Run with `npm run test:books-db`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'reports-db-'));
process.env.DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
process.env.EXTENSION_DATA_KEY = 'ab'.repeat(32);
execFileSync('npx', ['prisma', 'migrate', 'deploy'], { env: process.env, stdio: 'pipe' });

const { prisma, upsertSetting } = await import('../db.ts');
const books = await import('./service.ts');
const { PrismaStore } = await import('./prismaStore.ts');
const { balanceSheet } = await import('./balanceSheet.ts');
const { inventoryOnHand } = await import('./inventory.ts');
const { scheduleC } = await import('./scheduleC.ts');
const { check1099K } = await import('./k1099.ts');
const { toBeancount } = await import('./beancount.ts');

after(async () => { await prisma.$disconnect(); rmSync(dir, { recursive: true, force: true }); });

test('reports over a reconciled ledger tie out, and the 1099-K table is unique per user, year and payer', async () => {
  const u = (await prisma.user.create({ data: { name: 'reports test' } })).id;
  for (const [k, v] of [['accounting.enabled', 'true'], ['accounting.goLive', '2027-01-01']]) await upsertSetting(u, k, v);
  const buyer = await prisma.buyer.create({ data: { name: 'Test Buyer Co' } });
  const o = await prisma.order.create({ data: { userId: u, platform: 'Acme', orderNumber: 'A-1', orderDate: new Date('2027-02-01T20:00:00Z'), cost: 50, salePrice: 90, bfmrStatus: 'paid', buyerId: buyer.id } });
  const o2 = await prisma.order.create({ data: { userId: u, platform: 'Acme', orderNumber: 'A-2', orderDate: new Date('2027-02-03T20:00:00Z'), cost: 20 } });
  const s = new PrismaStore();
  await s.stampEvent(o.id, 'sold', '2027-03-01');
  await s.stampEvent(o.id, 'paid', '2027-03-05');
  await books.runReconcile(u, new Date('2027-04-01T20:00:00Z'));

  const lines = await s.ledgerLines(u);
  assert.ok(lines.length > 0);
  const bs = balanceSheet(lines, '2027-04-01');
  assert.equal(bs.differenceCents, 0);
  const inv = inventoryOnHand(lines, '2027-04-01', new Map([[o2.id, '2027-02-03']]));
  assert.equal(inv.differenceCents, 0);
  assert.deepEqual(inv.lots.map(l => [l.orderId, l.valueCents]), [[o2.id, 2000]]);
  const sc = scheduleC(lines, 2027, 'resell');
  assert.equal(sc.line1Cents, 9000);
  assert.equal(sc.line4Cents, 5000);
  assert.ok(toBeancount(lines).includes('balance Assets:1400'));

  const base = { userId: u, year: 2027, payerName: 'Pay Co', payerKeys: `buyer:${buyer.id}`, amountCents: 9000 };
  const row = await prisma.form1099K.create({ data: base });
  await assert.rejects(prisma.form1099K.create({ data: base }));
  const [chk] = check1099K(lines, [{ id: row.id, year: row.year, payerName: row.payerName, payerKeys: row.payerKeys, amountCents: row.amountCents, transactions: row.transactions, note: row.note }]);
  assert.equal(chk.booksGrossCents, 9000);
  assert.equal(chk.status, 'match');
});
