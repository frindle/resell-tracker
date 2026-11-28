// DB-level tests: a deposit equal to a stored group payment is matched to its orders and auto-accepted. Made-up data only.
// Run with `npm run test:books-db`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'grouppay-db-'));
process.env.DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
process.env.EXTENSION_DATA_KEY = 'ab'.repeat(32);
execFileSync('npx', ['prisma', 'migrate', 'deploy'], { env: process.env, stdio: 'pipe' });

const { prisma, upsertSetting } = await import('../../db.ts');
const svc = await import('./service.ts');
const gpay = await import('../../groupPayments.ts');
const { PrismaStore } = await import('../prismaStore.ts');

after(async () => { await prisma.$disconnect(); rmSync(dir, { recursive: true, force: true }); });

let u = 0;
async function setup() {
  u = (await prisma.user.create({ data: { name: `grouppay ${Math.random()}` } })).id;
  for (const [k, v] of [['accounting.enabled', 'true'], ['accounting.goLive', '2027-01-01'], ['accounting.bankPosting', 'true']]) await upsertSetting(u, k, v);
  const la = await prisma.ledgerAccount.create({ data: { userId: u, code: '1010', name: 'Checking', type: 'asset', business: 'shared' } });
  const acct = await prisma.bankAccount.create({ data: { userId: u, provider: 'ofx', providerAccountId: `ofx:${u}`, name: 'Checking', ledgerAccountId: la.id } });
  const buyer = await prisma.buyer.create({ data: { name: `Acme Buying ${u}` } });
  const row = (id: string, amountCents: number, postedDate: string, description: string) =>
    prisma.bankTransaction.create({ data: { userId: u, bankAccountId: acct.id, providerTxnId: id, source: 'ofx', postedDate, amountCents, description } });
  const order = async (num: string, sale: number, paidDay = '2027-03-01') => {
    const o = await prisma.order.create({ data: { userId: u, platform: 'Acme', orderNumber: num, orderDate: new Date('2027-02-01T20:00:00Z'), cost: 10, salePrice: sale, bfmrStatus: 'paid', buyerId: buyer.id } });
    const s = new PrismaStore();
    await s.stampEvent(o.id, 'sold', paidDay);
    await s.stampEvent(o.id, 'paid', paidDay);
    return o;
  };
  return { buyer, row, order };
}
const links = (txnId: number) => prisma.bankMatch.findMany({ where: { txnId }, orderBy: { refId: 'asc' } });

test('stored payment: an exact deposit is auto-accepted to exactly its orders (autoMatch on), with a name that is not a learned payee', async () => {
  const { buyer, row, order } = await setup();
  const os = [await order('G-1', 120.5), await order('G-2', 80.25), await order('G-3', 100.1), await order('G-4', 99.99)];
  await order('G-5', 80.25); // same amount as G-2, not in the payment: a guess could pick it
  await gpay.recordGroupPayment(u, 'cardcenter', 'P1-20270301', 400.84, '2027-03-01', new Map(os.map((o, i) => [o.id, [120.5, 80.25, 100.1, 99.99][i]])));
  const p = await prisma.groupPayment.findFirstOrThrow({ where: { userId: u }, include: { orders: true } });
  assert.deepEqual([p.buyerId, p.amountCents, p.paidDate, p.orders.length], [buyer.id, 40084, '2027-03-01', 4]);
  const d = await row('g1', 40084, '2027-03-03', `ACH: ${buyer.name}`);
  await svc.runMatching(u);
  assert.equal((await links(d.id)).length, 0); // autoMatch off: suggested only
  const t = await prisma.bankTransaction.findUniqueOrThrow({ where: { id: d.id } });
  const s = JSON.parse(t.suggestion!);
  assert.deepEqual([t.matchStatus, s.options.length, s.options[0].how], ['suggested', 1, 'payment']);
  await upsertSetting(u, 'accounting.autoMatch', 'true');
  await svc.runMatching(u);
  const l = await links(d.id);
  assert.deepEqual(l.map(x => [x.kind, x.refId, x.amountCents, x.matchedBy]), os.map((o, i) => ['payout', o.id, [12050, 8025, 10010, 9999][i], 'auto:deposit']));
});

test('stored payment: refreshing replaces the order list; a payment with a fee links the batch total and leaves the shortfall to classify', async () => {
  const { buyer, row, order } = await setup();
  const a = await order('F-1', 100), b = await order('F-2', 50);
  await gpay.recordGroupPayment(u, 'cardcenter', 'P2-20270301', 100, '2027-03-01', new Map([[a.id, 100]]));
  await gpay.recordGroupPayment(u, 'cardcenter', 'P2-20270301', 145, '2027-03-01', new Map([[a.id, 95], [b.id, 50]]));
  assert.equal(await prisma.groupPayment.count({ where: { userId: u } }), 1);
  assert.equal(await prisma.groupPaymentOrder.count({ where: { payment: { userId: u } } }), 2);
  const d = await row('f1', 14500, '2027-03-02', `ACH: ${buyer.name}`);
  await upsertSetting(u, 'accounting.autoMatch', 'true');
  await svc.runMatching(u);
  const l = await links(d.id);
  assert.equal(l.reduce((x, y) => x + y.amountCents, 0), 14500);
  assert.ok(l.every(x => x.matchedBy === 'auto:deposit'));
  assert.ok(l.some(x => x.note === 'short=500'));
});

test('no stored payment match: the old suggestion stays, and a deposit outside the 7 days is not matched to the payment', async () => {
  const { buyer, row, order } = await setup();
  const a = await order('N-1', 70), b = await order('N-2', 30);
  await gpay.recordGroupPayment(u, 'cardcenter', 'P3-20270301', 100, '2027-03-01', new Map([[a.id, 70], [b.id, 30]]));
  const d = await row('n1', 10000, '2027-03-12', `ACH: ${buyer.name}`);
  await svc.runMatching(u);
  const t = await prisma.bankTransaction.findUniqueOrThrow({ where: { id: d.id } });
  assert.equal(JSON.parse(t.suggestion!).options[0].how, 'batch');
});

test('bfmr: reservations paid the same day make one batch; a deposit of the amount_paid total is auto-accepted and records the fee', async () => {
  const { buyer, row, order } = await setup();
  const o1 = await order('B-1', 100), o2 = await order('B-2', 100), o3 = await order('B-3', 100);
  const rsv = (n: string, orderId: number, paid: number, payout: number, date: string) => prisma.bfmrReservation.create({
    data: {
      userId: u, lineKey: `${n}-${u}`, status: 'paid', qty: 1, totalPayout: payout, datePaid: new Date(`${date}T15:00:00Z`),
      raw: JSON.stringify({ amount_paid: String(paid), date_paid: `${date} 15:00:00` }),
      orderLinks: { create: { orderId, quantity: 1, value: payout } },
    },
  });
  await rsv('r1', o1.id, 96.1, 100, '2027-03-01'); await rsv('r2', o2.id, 100, 100, '2027-03-01'); await rsv('r3', o3.id, 96.1, 100, '2027-03-01');
  await upsertSetting(u, 'accounting.autoMatch', 'true');
  const d = await row('b1', 29220, '2027-03-02', `ACH: ${buyer.name}`);
  await svc.runMatching(u);
  const l = await links(d.id);
  assert.deepEqual(l.filter(x => x.kind === 'payout').map(x => [x.refId, x.amountCents, x.matchedBy, x.note]), [[o1.id, 9610, 'auto:deposit', 'short=390'], [o2.id, 10000, 'auto:deposit', null], [o3.id, 9610, 'auto:deposit', 'short=390']]);
});

test('bg: a stored payment total is kept once, and a deposit of it finds the one exact subset of BG-paid orders', async () => {
  const { buyer, row, order } = await setup();
  const mk = async (n: string, sale: number, paid: number | null) => {
    const o = await order(n, sale);
    return prisma.order.update({ where: { id: o.id }, data: { bgPaidAmount: paid } });
  };
  const a = await mk('P-1', 500, 500), b = await mk('P-2', 400, 400), c = await mk('P-3', 310.1, 310.1), x = await mk('P-4', 310.1, null);
  await gpay.recordGroupPaymentTotal(u, 'bg', 'PAY-1', 1210.1, '2027-03-01', buyer.id);
  await gpay.recordGroupPaymentTotal(u, 'bg', 'PAY-1', 1210.1, '2027-03-01', buyer.id);
  assert.equal(await prisma.groupPayment.count({ where: { userId: u } }), 1);
  const d = await row('p1', 121010, '2027-03-03', `ACH: ${buyer.name}`);
  await svc.runMatching(u);
  const t = await prisma.bankTransaction.findUniqueOrThrow({ where: { id: d.id } });
  const s = JSON.parse(t.suggestion!);
  assert.equal(s.options.length, 1);
  assert.deepEqual(s.options[0].parts.map((p: { orderId: number }) => p.orderId), [a.id, b.id, c.id]);
  assert.equal(s.options[0].payment, 'bg:PAY-1');
  assert.ok(x.id > 0);
});
