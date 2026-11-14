// DB-level tests for P3 step 3c: deposits to payouts, payee aliases, shortfalls, the Darkbloom link, the lock gate and the
// pre-go-live check, against a real SQLite file (migrations applied to a temp DB). Run with `npm run test:books-db`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'payouts-db-'));
process.env.DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
process.env.EXTENSION_DATA_KEY = 'ab'.repeat(32);
execFileSync('npx', ['prisma', 'migrate', 'deploy'], { env: process.env, stdio: 'pipe' });

const { prisma, upsertSetting } = await import('../../db.ts');
const svc = await import('./service.ts');
const books = await import('../service.ts');
const post = await import('./posting.ts');
const po = await import('./payouts.ts');
const pob = await import('./payoutOrders.ts');
const { PrismaStore } = await import('../prismaStore.ts');

after(async () => { await prisma.$disconnect(); rmSync(dir, { recursive: true, force: true }); });

const NOW = new Date('2027-03-20T20:00:00Z');
let u = 0;
async function setup() {
  u = (await prisma.user.create({ data: { name: `payouts ${Math.random()}` } })).id;
  for (const [k, v] of [['accounting.enabled', 'true'], ['accounting.goLive', '2027-01-01'], ['accounting.bankPosting', 'true']]) await upsertSetting(u, k, v);
  const la = await prisma.ledgerAccount.create({ data: { userId: u, code: '1010', name: 'Checking', type: 'asset', business: 'shared' } });
  const acct = await prisma.bankAccount.create({ data: { userId: u, provider: 'ofx', providerAccountId: `ofx:${u}`, name: 'Checking', ledgerAccountId: la.id } });
  const buyer = await prisma.buyer.create({ data: { name: `BuyerCo ${u}` } });
  const row = (id: string, amountCents: number, postedDate: string, description = 'ACH CREDIT BUYERCO 111') =>
    prisma.bankTransaction.create({ data: { userId: u, bankAccountId: acct.id, providerTxnId: id, source: 'ofx', postedDate, amountCents, description } });
  // a paid order: sold, paid (stamped on a fixed day so the tests do not depend on today's date)
  const order = async (num: string, sale: number, paidDay = '2027-02-20', buyerId: number | null = buyer.id, orderDate = '2027-02-01') => {
    const o = await prisma.order.create({ data: { userId: u, platform: 'Acme', orderNumber: num, orderDate: new Date(`${orderDate}T20:00:00Z`), cost: 10, salePrice: sale, bfmrStatus: 'paid', buyerId } });
    const s = new PrismaStore();
    await s.stampEvent(o.id, 'sold', paidDay);
    await s.stampEvent(o.id, 'paid', paidDay);
    return o;
  };
  return { la, acct, buyer, row, order };
}
const live = () => prisma.journalEntry.findMany({ where: { userId: u, sourceKey: { startsWith: 'bank:' }, reversedAt: null, source: 'bank' }, include: { lines: { include: { account: true } } } });
const sum = (e: { lines: { amountCents: number }[] }) => e.lines.reduce((s, l) => s + l.amountCents, 0);
const sugg = async (id: number) => { const t = await prisma.bankTransaction.findUniqueOrThrow({ where: { id } }); return { status: t.matchStatus, s: t.suggestion ? JSON.parse(t.suggestion) : null }; };

test('deposit: suggested (never linked while autoMatch is off), accepted, posts Dr cash / Cr 1100 per order once, learns the payee, undo reverses', async () => {
  const { la, buyer, row, order } = await setup();
  const o1 = await order('D-1', 100), o2 = await order('D-2', 60);
  const dep = await row('d1', 16000, '2027-03-02');
  await svc.runMatching(u);
  const g = await sugg(dep.id);
  assert.equal(g.status, 'suggested');
  assert.equal(g.s.kind, 'deposit');
  assert.equal(g.s.aliased, false);
  assert.deepEqual(g.s.options.map((o: { how: string }) => o.how), ['batch']);
  assert.equal(await prisma.bankMatch.count({ where: { txnId: dep.id } }), 0);
  await svc.applyMatchAction(u, dep.id, { action: 'accept' });
  const links = await prisma.bankMatch.findMany({ where: { txnId: dep.id }, orderBy: { refId: 'asc' } });
  assert.deepEqual(links.map(l => [l.kind, l.refId, l.amountCents, l.note, l.matchedBy]), [['payout', o1.id, 10000, null, 'user'], ['payout', o2.id, 6000, null, 'user']]);
  const alias = await prisma.payeeAlias.findMany({ where: { userId: u } });
  assert.deepEqual(alias.map(a => [a.token, a.buyerId]), [['ACH CREDIT BUYERCO', buyer.id]]);
  const e = (await live()).find(x => x.sourceKey === `bank:${dep.id}`)!;
  assert.equal(sum(e), 0);
  assert.equal(e.lines.find(l => l.accountId === la.id)?.amountCents, 16000);
  assert.deepEqual(e.lines.filter(l => l.account.systemKey === 'undeposited_payouts').map(l => [l.orderId, l.amountCents]).sort(), [[o1.id, -10000], [o2.id, -6000]]);
  const r2 = await books.runReconcile(u, NOW);
  assert.deepEqual([r2.bank.posted, r2.bank.reversed], [0, 0]);
  // the cleared orders are no longer offered
  const again = await row('d1b', 16000, '2027-03-03');
  await svc.runMatching(u);
  assert.equal((await sugg(again.id)).status, 'unmatched');
  await svc.applyMatchAction(u, dep.id, { action: 'reset' });
  assert.equal((await live()).length, 0);
  assert.equal(await prisma.bankMatch.count({ where: { txnId: dep.id } }), 0);
  assert.equal(await prisma.payeeAlias.count({ where: { userId: u } }), 1); // the alias outlives the undo
});

test('auto-accept: only with autoMatch on AND a known payee; a deposit from an unknown payee stays suggested; undo sticks', async () => {
  const { buyer, row, order } = await setup();
  await prisma.payeeAlias.create({ data: { userId: u, buyerId: buyer.id, token: 'ACH CREDIT BUYERCO' } });
  const o1 = await order('A-1', 50), o2 = await order('A-2', 70, '2027-02-21');
  const known = await row('a1', 5000, '2027-03-02');
  const unknown = await row('a2', 7000, '2027-03-02', 'WIRE FROM SOMEWHERE ELSE 9');
  await svc.runMatching(u);
  assert.equal(await prisma.bankMatch.count({ where: { userId: u } }), 0); // autoMatch off
  await upsertSetting(u, 'accounting.autoMatch', 'true');
  await svc.runMatching(u);
  const l = await prisma.bankMatch.findFirstOrThrow({ where: { txnId: known.id } });
  assert.deepEqual([l.kind, l.refId, l.matchedBy], ['payout', o1.id, 'auto:deposit']);
  assert.equal(await prisma.bankMatch.count({ where: { txnId: unknown.id } }), 0);
  const g = await sugg(unknown.id);
  assert.deepEqual([g.status, g.s.kind, g.s.aliased], ['suggested', 'deposit', false]);
  assert.deepEqual(g.s.options[0].parts, [{ orderId: o2.id, cents: 7000 }]);
  await svc.applyMatchAction(u, known.id, { action: 'reset' });
  await svc.runMatching(u);
  assert.equal(await prisma.bankMatch.count({ where: { txnId: known.id } }), 0); // an undone auto match is not redone
  await upsertSetting(u, 'accounting.autoMatch', 'false');
});

test('near miss: suggested with a shortfall, never auto; the shortfall blocks the lock gate until classified; fee, then returns, then undo', async () => {
  const { buyer, row, order } = await setup();
  await prisma.payeeAlias.create({ data: { userId: u, buyerId: buyer.id, token: 'ACH CREDIT BUYERCO' } });
  await upsertSetting(u, 'accounting.autoMatch', 'true');
  const o = await order('N-1', 100);
  const dep = await row('n1', 9800, '2027-03-02');
  await svc.runMatching(u);
  const g = await sugg(dep.id);
  assert.deepEqual([g.status, g.s.options[0].how, g.s.options[0].shortfallCents], ['suggested', 'near', 200]);
  assert.equal(await prisma.bankMatch.count({ where: { txnId: dep.id } }), 0);
  await svc.applyMatchAction(u, dep.id, { action: 'accept' });
  const l = await prisma.bankMatch.findFirstOrThrow({ where: { txnId: dep.id } });
  assert.deepEqual([l.kind, l.refId, l.amountCents, l.note], ['payout', o.id, 9800, 'short=200']);
  const gate = await post.lockGate(u, '2027-03', '2027-01-01');
  assert.equal(gate.ok, false);
  assert.deepEqual(gate.shortfalls.map(x => [x.txnId, x.shortCents]), [[dep.id, 200]]);
  assert.equal((await post.lockGate(u, '2027-02', '2027-01-01')).shortfalls.length, 0); // dated in March only
  await svc.applyMatchAction(u, dep.id, { action: 'shortfall', choice: 'fee' });
  assert.equal((await post.lockGate(u, '2027-03', '2027-01-01')).shortfalls.length, 0);
  const lines = async () => (await live()).find(x => x.sourceKey === `bank:${dep.id}`)!.lines.map(x => [x.account.systemKey ?? x.account.code, x.amountCents]);
  assert.deepEqual(await lines(), [['1010', 9800], ['undeposited_payouts', -9800], ['exp_commissions', 200], ['undeposited_payouts', -200]]);
  await svc.applyMatchAction(u, dep.id, { action: 'shortfall', choice: 'returns' }); // reclassify: the entry is replaced
  assert.deepEqual((await lines()).slice(2), [['returns_allowances', 200], ['undeposited_payouts', -200]]);
  assert.equal((await live()).length, 1);
  const r2 = await books.runReconcile(u, NOW);
  assert.deepEqual([r2.bank.posted, r2.bank.reversed], [0, 0]);
  await svc.applyMatchAction(u, dep.id, { action: 'reset' }); // wrong match
  assert.equal((await live()).length, 0);
  assert.equal(await prisma.bankMatch.count({ where: { txnId: dep.id } }), 0);
  await assert.rejects(svc.applyMatchAction(u, dep.id, { action: 'shortfall', choice: 'fee' }), /no shortfall/);
});

test('pieces: a deposit smaller than the order, "more coming" leaves the rest open, a second deposit clears it', async () => {
  const { row, order } = await setup();
  const o = await order('P-1', 200);
  const d1 = await row('p1', 12000, '2027-03-02');
  const d2 = await row('p2', 8000, '2027-03-10');
  await svc.applyMatchAction(u, d1.id, { action: 'deposit', orderIds: [o.id] });
  const l1 = await prisma.bankMatch.findFirstOrThrow({ where: { txnId: d1.id } });
  assert.deepEqual([l1.amountCents, l1.note], [12000, 'short=8000']);
  assert.equal((await pob.loadPayoutOrders(u)).all.find(x => x.orderId === o.id)?.openCents, 8000); // not yet classified: still open
  await svc.applyMatchAction(u, d1.id, { action: 'shortfall', choice: 'more' });
  const open = (await pob.loadPayoutOrders(u)).all.find(x => x.orderId === o.id)!;
  assert.deepEqual([open.openCents, open.paidCents], [8000, 20000]);
  assert.equal((await post.lockGate(u, '2027-03', '2027-01-01')).shortfalls.length, 0); // classified
  await svc.runMatching(u);
  const g = await sugg(d2.id);
  assert.deepEqual(g.s.options.map((x: { how: string; parts: unknown[] }) => [x.how, x.parts]), [['single', [{ orderId: o.id, cents: 8000 }]]]);
  await svc.applyMatchAction(u, d2.id, { action: 'accept' });
  assert.equal((await pob.loadPayoutOrders(u)).all.find(x => x.orderId === o.id)?.openCents, 0);
  const es = await live();
  assert.equal(es.length, 2);
  assert.ok(es.every(e => sum(e) === 0));
  assert.equal(es.flatMap(e => e.lines).filter(x => x.account.systemKey === 'undeposited_payouts').reduce((a, x) => a + x.amountCents, 0), -20000);
});

test('manual deposit: owed less than the deposit is refused; a card account or a debit is refused; several orders get pro rata cash', async () => {
  const { row, order, buyer } = await setup();
  const a = await order('M-1', 100), b = await order('M-2', 50);
  const big = await row('m1', 20000, '2027-03-02');
  await assert.rejects(svc.applyMatchAction(u, big.id, { action: 'deposit', orderIds: [a.id, b.id] }), /owed less/);
  await assert.rejects(svc.applyMatchAction(u, big.id, { action: 'deposit', orderIds: [] }), /choose the orders/);
  const debit = await row('m2', -500, '2027-03-02');
  await assert.rejects(svc.applyMatchAction(u, debit.id, { action: 'deposit', orderIds: [a.id] }), /credit/);
  const short = await row('m3', 14000, '2027-03-03');
  await svc.applyMatchAction(u, short.id, { action: 'deposit', orderIds: [a.id, b.id] });
  const ls = await prisma.bankMatch.findMany({ where: { txnId: short.id }, orderBy: { refId: 'asc' } });
  assert.equal(ls.reduce((s, l) => s + l.amountCents, 0), 14000);
  assert.equal(ls.reduce((s, l) => s + Number(l.note!.slice(6)), 0), 1000);
  assert.equal((await prisma.payeeAlias.findFirst({ where: { userId: u } }))?.buyerId, buyer.id);
});

test('darkbloom: any number of pieces link from credit rows, post Dr cash / Cr 1500, and the view shows received by month', async () => {
  const { la, row } = await setup();
  const a = await row('b1', 90000, '2027-03-05', 'ACH CREDIT DARKBLOOM'), b = await row('b2', 60000, '2027-03-19', 'ACH CREDIT DARKBLOOM');
  const out = await row('b3', -100, '2027-03-19');
  await assert.rejects(svc.applyMatchAction(u, out.id, { action: 'darkbloom' }), /credit/);
  await svc.applyMatchAction(u, a.id, { action: 'darkbloom' });
  await svc.applyMatchAction(u, b.id, { action: 'darkbloom' });
  const es = await live();
  assert.equal(es.length, 2);
  for (const e of es) {
    assert.equal(sum(e), 0);
    assert.ok(e.lines.some(l => l.account.systemKey === 'darkbloom_balance' && l.amountCents < 0));
    assert.ok(e.lines.some(l => l.accountId === la.id && l.amountCents > 0));
  }
  const r2 = await books.runReconcile(u, NOW);
  assert.deepEqual([r2.bank.posted, r2.bank.reversed], [0, 0]);
  const v = await po.darkbloomView(u, '2027-01-01');
  assert.deepEqual(v.months.map(m => [m.month, m.receivedCents, m.pieces]), [['2027-03', 150000, 2]]);
  assert.equal(v.balanceCents, -150000); // nothing was added to 1500 in this test, so the payouts show as received ahead of the balance
  // an unmapped account is refused
  const un = await prisma.bankAccount.create({ data: { userId: u, provider: 'ofx', providerAccountId: `ofx:un${u}`, name: 'Personal' } });
  const pr = await prisma.bankTransaction.create({ data: { userId: u, bankAccountId: un.id, providerTxnId: 'b4', source: 'ofx', postedDate: '2027-03-19', amountCents: 500, description: 'x' } });
  await assert.rejects(svc.applyMatchAction(u, pr.id, { action: 'darkbloom' }), /not in your books/);
});

test('reconcile check: pre-go-live paid orders not yet deposited against the opening undeposited amount', async () => {
  const { order, row } = await setup();
  await order('G-1', 30, '2026-12-20', null, '2026-12-01');
  await order('G-2', 20, '2026-12-22', null, '2026-12-02');
  await order('G-3', 99, '2027-02-20'); // after go-live: not part of the check
  await upsertSetting(u, 'accounting.openingInput', JSON.stringify({ undepositedCents: 4000 }));
  const c = await pob.preGoLiveUndeposited(u, NOW);
  assert.deepEqual([c.ordersCents, c.openingCents, c.differenceCents, c.orders], [5000, 4000, 1000, 2]);
  // a deposit for a pre-go-live payout, after go-live, clears 1100 like any other and does not change the check
  const dep = await row('g1', 3000, '2027-01-15');
  const o1 = (await pob.loadPayoutOrders(u, NOW)).all.find(x => x.paidCents === 3000)!;
  await svc.applyMatchAction(u, dep.id, { action: 'deposit', orderIds: [o1.orderId] });
  assert.equal((await live()).length, 1);
  assert.equal((await pob.preGoLiveUndeposited(u, NOW)).differenceCents, 1000);
});

test('alias learning: not learned when the orders belong to different buyers; the latest accepted deposit wins a token', async () => {
  const { row, order, buyer } = await setup();
  const other = await prisma.buyer.create({ data: { name: `Other ${u}` } });
  const a = await order('L-1', 40), b = await order('L-2', 60, '2027-02-20', other.id);
  const mixed = await row('l1', 10000, '2027-03-02');
  await svc.applyMatchAction(u, mixed.id, { action: 'deposit', orderIds: [a.id, b.id] });
  assert.equal(await prisma.payeeAlias.count({ where: { userId: u } }), 0);
  await svc.applyMatchAction(u, mixed.id, { action: 'reset' });
  const one = await row('l2', 4000, '2027-03-03');
  await svc.applyMatchAction(u, one.id, { action: 'deposit', orderIds: [a.id] });
  assert.equal((await prisma.payeeAlias.findFirstOrThrow({ where: { userId: u } })).buyerId, buyer.id);
  const two = await row('l3', 6000, '2027-03-04');
  await svc.applyMatchAction(u, two.id, { action: 'deposit', orderIds: [b.id] });
  assert.equal((await prisma.payeeAlias.findFirstOrThrow({ where: { userId: u } })).buyerId, other.id);
});
