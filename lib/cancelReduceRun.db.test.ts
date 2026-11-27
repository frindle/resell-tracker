// DB-level tests of the BG commitment reduction against a real SQLite file, with a fake BG. Run with
// `npm run test:cancel-reduce-db` (needs `prisma generate`).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'cancel-reduce-db-'));
process.env.DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
execFileSync('npx', ['prisma', 'migrate', 'deploy'], { env: process.env, stdio: 'pipe' });

const { prisma } = await import('./db.ts');
const { reduceBgCommitments } = await import('./cancelReduceRun.ts');
type Deps = NonNullable<Parameters<typeof reduceBgCommitments>[4]>;
type Live = NonNullable<Awaited<ReturnType<Deps['read']>>> extends Map<string, infer V> ? V : never;

let userId = 0;
let seq = 0;
before(async () => { userId = (await prisma.user.create({ data: { name: 'cancel-reduce-test' } })).id; });
after(async () => { await prisma.$disconnect(); rmSync(dir, { recursive: true, force: true }); });

const NOW = new Date('2026-11-20T12:00:00Z');

function fakeBg(over: Record<string, unknown> = {}) {
  const edits: { dealKey: string; itemKey: string; quantity: number }[] = [];
  let cm = '';
  let count = 0;
  const deps: Deps = {
    read: async () => new Map([[cm, { commitment_id: cm, count, status: 'ACTIVE', editable: true, deal_status: true, expiry_day: '12-31-2026', deal: { key: 'dk' }, item: { key: 'ik' }, ...over } as unknown as Live]]),
    edit: async (_u, dealKey, itemKey, quantity) => { edits.push({ dealKey, itemKey, quantity }); },
  };
  return { deps, edits, bind: (id: string, n: number) => { cm = id; count = n; } };
}

// A commitment of `count` units with one cancelled order and the given live orders linked.
async function setup(count: number, released: number, live: number[]) {
  const n = ++seq;
  const c = await prisma.buyingGroupCommitment.create({
    data: { userId, commitmentId: `CM-${n}`, dealId: `DL-${n}`, dealTitle: 'Test Kettle', count, fulfilled: 0, price: 10, commission: 0, total: 10 * count, status: 'ACTIVE' },
  });
  for (const [i, q] of live.entries()) {
    const o = await prisma.order.create({ data: { userId, platform: 'Test', orderDate: new Date('2026-11-01'), cost: 10 * q, cancelled: false } });
    await prisma.orderCommitmentLink.create({ data: { orderId: o.id, commitmentId: c.id, quantity: q } });
    void i;
  }
  const gone = await prisma.order.create({ data: { userId, platform: 'Test', orderDate: new Date('2026-11-01'), cost: 0, cancelled: true } });
  return { c, rel: [{ commitmentId: c.id, name: 'Test Kettle', quantity: released }], gone };
}

test('setting on: lowers BG by the released units and the local row follows', async () => {
  const { c, rel } = await setup(5, 2, []);
  const bg = fakeBg();
  bg.bind(c.commitmentId, 5);
  const out = await reduceBgCommitments(userId, rel, true, NOW, bg.deps);
  assert.deepEqual(out, [{ name: 'Test Kettle', state: 'reduced', from: 5, to: 3 }]);
  assert.deepEqual(bg.edits, [{ dealKey: 'dk', itemKey: 'ik', quantity: 3 }]);
  const row = await prisma.buyingGroupCommitment.findUniqueOrThrow({ where: { id: c.id } });
  assert.equal(row.count, 3);
  assert.equal(row.total, 30);
});

test('units other live orders hold are never cut', async () => {
  const { c, rel } = await setup(5, 3, [3]);
  const bg = fakeBg();
  bg.bind(c.commitmentId, 5);
  const out = await reduceBgCommitments(userId, rel, true, NOW, bg.deps);
  assert.deepEqual(out, [{ name: 'Test Kettle', state: 'reduced', from: 5, to: 3 }]);
});

test('setting off: plans, never calls BG, changes nothing', async () => {
  const { c, rel } = await setup(5, 2, []);
  const bg = fakeBg();
  bg.bind(c.commitmentId, 5);
  const out = await reduceBgCommitments(userId, rel, false, NOW, bg.deps);
  assert.deepEqual(out, [{ name: 'Test Kettle', state: 'would', from: 5, to: 3 }]);
  assert.equal(bg.edits.length, 0);
  assert.equal((await prisma.buyingGroupCommitment.findUniqueOrThrow({ where: { id: c.id } })).count, 5);
});

test('a closed, expired or non-editable commitment is skipped with a reason', async () => {
  for (const over of [{ status: 'COMPLETED' }, { deal_status: false }, { expiry_day: '11-01-2026' }, { editable: false }]) {
    const { c, rel } = await setup(5, 2, []);
    const bg = fakeBg(over);
    bg.bind(c.commitmentId, 5);
    const out = await reduceBgCommitments(userId, rel, true, NOW, bg.deps);
    assert.equal(out[0].state, 'skipped');
    assert.equal(bg.edits.length, 0);
  }
});

test('BG holding fewer units than were released is skipped', async () => {
  const { c, rel } = await setup(5, 4, []);
  const bg = fakeBg();
  bg.bind(c.commitmentId, 3);
  const out = await reduceBgCommitments(userId, rel, true, NOW, bg.deps);
  assert.equal(out[0].state, 'skipped');
  assert.equal(bg.edits.length, 0);
});

test('BG unreachable: falls back to the synced row to say what would happen, never edits with it', async () => {
  const raw = JSON.stringify({ status: 'ACTIVE', editable: true, deal_status: true, expiry_day: '12-31-2026', deal: { key: 'dk' }, item: { key: 'ik' } });
  const { c, rel } = await setup(5, 2, []);
  await prisma.buyingGroupCommitment.update({ where: { id: c.id }, data: { raw } });
  const edits: number[] = [];
  const deps: Deps = { read: async () => null, edit: async (_u, _d, _i, q) => { edits.push(q); } };
  assert.deepEqual(await reduceBgCommitments(userId, rel, false, NOW, deps), [{ name: 'Test Kettle', state: 'would', from: 5, to: 3 }]);
  const out = await reduceBgCommitments(userId, rel, true, NOW, deps);
  assert.equal(out[0].state, 'skipped');
  assert.equal(edits.length, 0);
});

test('a BG error is reported as failed and never thrown; the local row is kept', async () => {
  const { c, rel } = await setup(5, 2, []);
  const bg = fakeBg();
  bg.bind(c.commitmentId, 5);
  const deps: Deps = { read: bg.deps.read, edit: async () => { throw new Error('boom'); } };
  const out = await reduceBgCommitments(userId, rel, true, NOW, deps);
  assert.equal(out[0].state, 'failed');
  assert.equal((await prisma.buyingGroupCommitment.findUniqueOrThrow({ where: { id: c.id } })).count, 5);
});
