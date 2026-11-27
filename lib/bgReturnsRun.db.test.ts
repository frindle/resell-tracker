// DB-level tests of the BG returns sync against a real SQLite file. Run with `npm run test:bg-returns-db`
// (needs `prisma generate`).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'bg-returns-db-'));
process.env.DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
execFileSync('npx', ['prisma', 'migrate', 'deploy'], { env: process.env, stdio: 'pipe' });

const { prisma } = await import('./db.ts');
const { applyTask } = await import('./bgReturnsRun.ts');
const { recalcSalePrice } = await import('./commitmentSalePrice.ts');
const { recalcReturnedCost } = await import('./orderReturns.ts');
type Task = Parameters<typeof applyTask>[1];

let userId = 0;
let seq = 0;
before(async () => { userId = (await prisma.user.create({ data: { name: 'bg-returns-test' } })).id; });
after(async () => { await prisma.$disconnect(); rmSync(dir, { recursive: true, force: true }); });

const task = (over: Partial<Task> = {}): Task => ({
  key: `t${++seq}`, receiptId: null, sku: 'SKU-1', serial: null, status: 'READY', voided: false, supportId: null,
  tracking: null, note: null, imageCount: 0, createdDt: null, updatedDt: null, ...over,
});

async function setup(orderOver: Record<string, unknown> = {}, sku = 'SKU-1') {
  const n = ++seq;
  const commitment = await prisma.buyingGroupCommitment.create({
    data: { userId, commitmentId: `CM-${n}`, dealId: `DL-${n}`, dealTitle: 'Test Kettle', count: 3, fulfilled: 0, price: 100, commission: 0, total: 300, status: 'ACTIVE', itemId: sku },
  });
  const order = await prisma.order.create({
    data: { userId, platform: 'Test', orderDate: new Date('2026-11-01'), cost: 300, salePrice: 300, ...orderOver },
  });
  await prisma.orderCommitmentLink.create({ data: { orderId: order.id, commitmentId: commitment.id, quantity: 3 } });
  return order.id;
}

test('a synced row from an open task does not move the sale price on a later reprice, and cost and price stay together', async () => {
  const orderId = await setup();
  assert.equal(await applyTask(userId, task()), 'return');
  assert.equal(await prisma.orderReturn.count({ where: { orderId } }), 1);
  // A reprice (or order-form save) recalculates the sale price: the untouched sync row is not netted out
  // while returnedCost is still 0.
  assert.equal(await recalcSalePrice(orderId), 300);
  // Once the order's returns are recalculated, cost and price both include the row.
  await recalcReturnedCost(orderId);
  const o = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  assert.ok(o.returnedCost > 0);
  assert.equal(await recalcSalePrice(orderId), 200);
});

test('an order found through an earlier task with the same serial is checked for lock and cancel too', async () => {
  const locked = await setup({ locked: true });
  const cancelled = await setup({ cancelled: true });
  for (const orderId of [locked, cancelled]) {
    const serial = `SN-${orderId}`;
    await prisma.bgReturnTask.create({ data: { userId, taskKey: `old${orderId}`, serial, status: 'SENT', orderId, matchedBy: 'tracking', syncedAt: new Date() } });
    assert.equal(await applyTask(userId, task({ serial, sku: null })), 'return');
    assert.equal(await prisma.orderReturn.count({ where: { orderId } }), 0, `order ${orderId} got no row`);
  }
});

test('an order carried by the prior task of the same key is checked as well', async () => {
  const orderId = await setup({ locked: true });
  const t = task({ sku: null });
  await prisma.bgReturnTask.create({ data: { userId, taskKey: t.key, status: 'READY', orderId, matchedBy: 'tracking', syncedAt: new Date() } });
  await applyTask(userId, t);
  assert.equal(await prisma.orderReturn.count({ where: { orderId } }), 0);
});

test('a new synced row on an order whose cost already includes another return is counted in cost and price together', async () => {
  const orderId = await setup({}, 'SKU-UNIQUE');
  const link = await prisma.orderCommitmentLink.findFirstOrThrow({ where: { orderId } });
  await prisma.orderReturn.create({ data: { orderId, commitmentLinkId: link.id, itemName: 'Test Kettle', quantity: 1, status: 'refunded', refundAmount: 90 } });
  await recalcReturnedCost(orderId);
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).returnedCost, 90);
  assert.equal(await applyTask(userId, task({ sku: 'SKU-UNIQUE' })), 'return');
  const after = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  // Second unit at the order's per-unit cost (100) on top of the 90 refund; one unit of three is left to sell.
  assert.equal(after.returnedCost, 190);
  assert.equal(after.salePrice, 100);
});
