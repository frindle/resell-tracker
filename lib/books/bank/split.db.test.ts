// DB-level tests for splitting a bank row, against a real SQLite file (migrations applied to a temp DB). Made-up data only.
// Run with `npm run test:books-db`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'split-db-'));
process.env.DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
execFileSync('npx', ['prisma', 'migrate', 'deploy'], { env: process.env, stdio: 'pipe' });

const { prisma, upsertSetting } = await import('../../db.ts');
const svc = await import('./service.ts');
const { runReconcile } = await import('../service.ts');
const { remainingChargeCents } = await import('../match.ts');

after(async () => { await prisma.$disconnect(); rmSync(dir, { recursive: true, force: true }); });
before(() => undefined);

async function setup() {
  const userId = (await prisma.user.create({ data: { name: 'split' } })).id;
  await upsertSetting(userId, 'accounting.enabled', 'true');
  await upsertSetting(userId, 'accounting.goLive', '2027-01-01');
  await upsertSetting(userId, 'accounting.bankPosting', 'true');
  const la = await prisma.ledgerAccount.create({ data: { userId, code: '1010', name: 'Checking', type: 'asset', business: 'shared' } });
  const mapped = await prisma.bankAccount.create({ data: { userId, provider: 'ofx', providerAccountId: 'ofx:s1', name: 'Mapped checking', ledgerAccountId: la.id } });
  const unmapped = await prisma.bankAccount.create({ data: { userId, provider: 'ofx', providerAccountId: 'ofx:s2', name: 'Other account' } });
  const row = (bankAccountId: number, id: string, amountCents: number, postedDate = '2027-02-10') =>
    prisma.bankTransaction.create({ data: { userId, bankAccountId, providerTxnId: id, source: 'ofx', postedDate, amountCents, description: `made up ${id}` } });
  const order = (orderNumber: string, cost: number) =>
    prisma.order.create({ data: { userId, platform: 'Acme', orderNumber, orderDate: new Date('2027-02-05T20:00:00Z'), cost, subtotalAmount: cost, taxAmount: 0 } });
  return { userId, la, mapped, unmapped, row, order };
}
const live = (userId: number, source: string) => prisma.journalEntry.findMany({ where: { userId, source, reversedAt: null }, include: { lines: true } });

test('split a charge into an order, personal and a cost: links, status, postings, then Undo removes it all', async () => {
  const { userId, la, mapped, row, order } = await setup();
  const o = await order('MADE-1', 200);
  const t = await row(mapped.id, 's1', -34683);
  await svc.applyMatchAction(userId, t.id, { action: 'split', parts: [
    { cents: 20000, kind: 'order', orderNumber: 'MADE-1' }, { cents: 9683, kind: 'personal' }, { cents: 5000, kind: 'cost', category: 'postage' },
  ] });
  const after1 = await prisma.bankTransaction.findUniqueOrThrow({ where: { id: t.id } });
  assert.equal(after1.matchStatus, 'matched');
  const links = await prisma.bankMatch.findMany({ where: { txnId: t.id }, orderBy: { kind: 'asc' } });
  assert.deepEqual(links.map(l => [l.kind, l.amountCents]), [['cost', 5000], ['order_charge', 20000], ['personal', 9683]]);
  assert.equal(links.find(l => l.kind === 'order_charge')!.refId, o.id);
  const cost = await prisma.costEntry.findUniqueOrThrow({ where: { id: links.find(l => l.kind === 'cost')!.refId } });
  assert.deepEqual([cost.amountCents, cost.category, cost.voidedAt], [5000, 'postage', null]);
  // the bank row posts the personal part only; the cost posts itself
  const bank = await live(userId, 'bank');
  assert.equal(bank.length, 1);
  assert.deepEqual(bank[0].lines.map(l => l.amountCents).sort((a, b) => a - b), [-9683, 9683]);
  assert.equal(bank[0].lines.reduce((s, l) => s + l.amountCents, 0), 0);
  const costEntries = await live(userId, 'cost');
  assert.equal(costEntries.length, 1);
  assert.equal(costEntries[0].lines.reduce((s, l) => s + l.amountCents, 0), 0);
  assert.ok(costEntries[0].lines.some(l => l.accountId === la.id && l.amountCents === -5000));
  // the order counts the part
  const sums = await prisma.bankMatch.aggregate({ where: { kind: 'order_charge', refId: o.id }, _sum: { amountCents: true } });
  assert.equal(sums._sum.amountCents, 20000);
  assert.equal(remainingChargeCents({ id: o.id, platform: 'Acme', orderNumber: null, orderDate: '', cardId: null, cost: 200, subtotalAmount: 200, taxAmount: 0, linkedCents: 20000 }).min, 0);
  assert.deepEqual([(await runReconcile(userId)).bank.posted], [0]); // steady
  // Undo
  await svc.applyMatchAction(userId, t.id, { action: 'reset' });
  assert.equal(await prisma.bankMatch.count({ where: { txnId: t.id } }), 0);
  assert.equal((await prisma.bankTransaction.findUniqueOrThrow({ where: { id: t.id } })).matchStatus, 'unmatched');
  assert.equal((await prisma.costEntry.findUniqueOrThrow({ where: { id: cost.id } })).voidedAt != null, true);
  assert.equal((await live(userId, 'bank')).length, 0);
  assert.equal((await live(userId, 'cost')).length, 0);
});

test('a part-order split leaves the rest of the order to be charged; two orders and same-ref parts merge', async () => {
  const { userId, mapped, row, order } = await setup();
  const a = await order('MADE-A', 100), b = await order('MADE-B', 50);
  const t = await row(mapped.id, 's2', -9000);
  await svc.applyMatchAction(userId, t.id, { action: 'split', parts: [
    { cents: 3000, kind: 'order', orderId: a.id }, { cents: 2000, kind: 'order', orderNumber: 'MADE-A' }, { cents: 4000, kind: 'order', orderId: b.id },
  ] });
  const links = await prisma.bankMatch.findMany({ where: { txnId: t.id }, orderBy: { refId: 'asc' } });
  assert.deepEqual(links.map(l => [l.kind, l.refId, l.amountCents]), [['order_charge', a.id, 5000], ['order_charge', b.id, 4000]]);
  assert.equal((await live(userId, 'bank')).length, 0);
  // order A is 10000, 5000 linked: another charge may still take the rest, but not more than it is owed once covered
  const t2 = await row(mapped.id, 's2b', -5000);
  await svc.applyMatchAction(userId, t2.id, { action: 'link', orderId: a.id });
  const t3 = await row(mapped.id, 's2c', -100);
  await assert.rejects(svc.applyMatchAction(userId, t3.id, { action: 'link', orderId: a.id }), /paid in full/);
});

test('bad splits are refused and write nothing: sum, unknown order, not open, unmapped cost; a failed split leaves no cost behind', async () => {
  const { userId, mapped, unmapped, row, order } = await setup();
  await order('MADE-C', 40);
  const t = await row(mapped.id, 's3', -4000);
  const split = (id: number, parts: unknown) => svc.applyMatchAction(userId, id, { action: 'split', parts });
  await assert.rejects(split(t.id, [{ cents: 1000, kind: 'order', orderNumber: 'MADE-C' }, { cents: 2000, kind: 'personal' }]), /add up to 3000/);
  await assert.rejects(split(t.id, [{ cents: 1000, kind: 'order', orderNumber: 'NOPE' }, { cents: 3000, kind: 'personal' }]), /no order has the number/);
  await assert.rejects(split(t.id, [{ cents: 1000, kind: 'order' }, { cents: 3000, kind: 'personal' }]), /order number or #id/);
  // a cost made first, then the order is not found: nothing is left behind
  await assert.rejects(split(t.id, [{ cents: 1000, kind: 'cost', category: 'postage' }, { cents: 3000, kind: 'order', orderNumber: 'NOPE' }]), /no order has the number/);
  assert.equal(await prisma.costEntry.count({ where: { userId } }), 0);
  assert.equal(await prisma.bankMatch.count({ where: { txnId: t.id } }), 0);
  assert.equal((await prisma.bankTransaction.findUniqueOrThrow({ where: { id: t.id } })).matchStatus, 'unmatched');
  const away = await row(unmapped.id, 's3b', -4000);
  await assert.rejects(split(away.id, [{ cents: 1000, kind: 'cost', category: 'postage' }, { cents: 3000, kind: 'personal' }]), /not in your books/);
  assert.equal(await prisma.costEntry.count({ where: { userId } }), 0);
  assert.equal(await prisma.bankMatch.count({ where: { txnId: away.id } }), 0);
  // an unmapped account may still split into an order and personal (nothing posts for it)
  await split(away.id, [{ cents: 1000, kind: 'order', orderNumber: 'MADE-C' }, { cents: 3000, kind: 'personal' }]);
  assert.equal((await prisma.bankTransaction.findUniqueOrThrow({ where: { id: away.id } })).matchStatus, 'matched');
  await assert.rejects(split(away.id, [{ cents: 1000, kind: 'personal' }, { cents: 3000, kind: 'personal' }]), /already linked/);
  // other users cannot split this row
  const other = (await prisma.user.create({ data: { name: 'other' } })).id;
  await assert.rejects(svc.applyMatchAction(other, t.id, { action: 'split', parts: [] }), /not found/);
});

test('split a credit: a return refund part and a personal part (owner contribution); a cost part is refused; the refund is capped', async () => {
  const { userId, mapped, row, order } = await setup();
  const o = await order('MADE-R', 45);
  const r = await prisma.orderReturn.create({ data: { orderId: o.id, itemName: 'made up item', status: 'refunded', refundAmount: 45, refundedAt: new Date('2027-02-08T20:00:00Z') } });
  const t = await row(mapped.id, 's4', 7000);
  const split = (parts: unknown) => svc.applyMatchAction(userId, t.id, { action: 'split', parts });
  await assert.rejects(split([{ cents: 4500, kind: 'order', returnId: r.id }, { cents: 2500, kind: 'cost', category: 'postage' }]), /debit/);
  await assert.rejects(split([{ cents: 5000, kind: 'order', returnId: r.id }, { cents: 2000, kind: 'personal' }]), /more than what is left/);
  await split([{ cents: 4500, kind: 'order', orderNumber: 'MADE-R' }, { cents: 2500, kind: 'personal' }]);
  const links = await prisma.bankMatch.findMany({ where: { txnId: t.id }, orderBy: { kind: 'asc' } });
  assert.deepEqual(links.map(l => [l.kind, l.refId, l.amountCents]), [['order_refund', r.id, 4500], ['personal', 0, 2500]]);
  const bank = await live(userId, 'bank');
  assert.equal(bank.length, 1);
  assert.deepEqual(bank[0].lines.map(l => l.amountCents).sort((a, b) => a - b), [-2500, 2500]);
  await svc.applyMatchAction(userId, t.id, { action: 'reset' });
  assert.equal(await prisma.bankMatch.count({ where: { txnId: t.id } }), 0);
  assert.equal((await live(userId, 'bank')).length, 0);
});
