// DB-level test of lib/expectedDeliveryDb.ts against a real SQLite file: the most recently SEEN observation
// wins, an older one never overwrites a newer one, cancelled orders and other users' orders are left alone.
// Run with `npm run test:books-db` (needs `prisma generate`).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'expected-delivery-db-'));
process.env.DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
execFileSync('npx', ['prisma', 'migrate', 'deploy'], { env: process.env, stdio: 'pipe' });

const { prisma } = await import('./db.ts');
const { recordExpectedDeliveries, recordExpectedFromText, recordExpectedForTracking } = await import('./expectedDeliveryDb.ts');

let uid = 0, other = 0;
const day = (s: string) => new Date(`${s}T00:00:00Z`);
const NOW = new Date('2026-11-21T12:00:00Z');
const mk = (userId: number, orderNumber: string, extra: Record<string, unknown> = {}) =>
  prisma.order.create({ data: { userId, platform: 'Amazon', orderNumber, orderDate: day('2026-11-15'), cost: 10, ...extra } });
const get = (id: number) => prisma.order.findUniqueOrThrow({ where: { id } });

before(async () => {
  uid = (await prisma.user.create({ data: { name: 'expected-test' } })).id;
  other = (await prisma.user.create({ data: { name: 'expected-other' } })).id;
});
after(async () => { await prisma.$disconnect(); rmSync(dir, { recursive: true, force: true }); });

test('newest sighting wins, whatever its date; an older sighting never overwrites', async () => {
  const o = await mk(uid, '111-2222222-3333331');
  const rec = (seenAt: string, start: string, end = start, source: 'email' | 'amazon-page' = 'email') =>
    recordExpectedDeliveries(uid, [{ orderNumber: '111-2222222-3333331', start: day(start), end: day(end), source, seenAt: new Date(seenAt) }], NOW);
  assert.equal(await rec('2026-11-18T10:00:00Z', '2026-11-30'), 1);
  // A later sighting with an EARLIER date replaces it (the merchant moved the date up).
  assert.equal(await rec('2026-11-20T10:00:00Z', '2026-11-25', '2026-11-26', 'amazon-page'), 1);
  let row = await get(o.id);
  assert.deepEqual([row.expectedDeliveryStart, row.expectedDeliveryEnd, row.expectedDeliverySource], [day('2026-11-25'), day('2026-11-26'), 'amazon-page']);
  // An older sighting (a replayed email) with a later date is ignored.
  assert.equal(await rec('2026-11-19T10:00:00Z', '2026-12-09'), 0);
  row = await get(o.id);
  assert.deepEqual([row.expectedDeliveryStart, row.expectedDeliverySeenAt], [day('2026-11-25'), new Date('2026-11-20T10:00:00Z')]);
});

test('a number written with other punctuation still finds the order; a cancelled order and another user are left alone', async () => {
  const a = await mk(uid, '111-2222222-3333332');
  const cancelled = await mk(uid, '111-2222222-3333333', { cancelled: true });
  const theirs = await mk(other, '111-2222222-3333334');
  const seenAt = new Date('2026-11-20T10:00:00Z');
  const obs = (orderNumber: string) => ({ orderNumber, start: day('2026-11-28'), end: day('2026-11-28'), source: 'email' as const, seenAt });
  assert.equal(await recordExpectedDeliveries(uid, [obs('1112222222 3333332'), obs('111-2222222-3333333'), obs('111-2222222-3333334')], NOW), 1);
  assert.equal((await get(a.id)).expectedDeliveryStart?.toISOString(), day('2026-11-28').toISOString());
  assert.equal((await get(cancelled.id)).expectedDeliveryStart, null);
  assert.equal((await get(theirs.id)).expectedDeliveryStart, null);
});

test('text is read relative to when it was seen', async () => {
  const o = await mk(uid, '111-2222222-3333335');
  const seen = new Date('2026-11-20T20:00:00Z');
  assert.equal(await recordExpectedFromText(uid, 'amazon-page', [{ orderNumber: '111-2222222-3333335', text: 'Arriving tomorrow' }, { orderNumber: '111-2222222-3333335', text: 'nothing' }], seen, NOW), 1);
  assert.equal((await get(o.id)).expectedDeliveryStart?.toISOString(), day('2026-11-21').toISOString());
});

test('a carrier page sets the expected day on the orders carrying that tracking number', async () => {
  const o = await mk(uid, '111-2222222-3333336', { trackingNumbers: '1Z999AA10123456784, 1Z999AA10123456785' });
  const unrelated = await mk(uid, '111-2222222-3333337', { trackingNumbers: '1Z999AA10123456999' });
  assert.equal(await recordExpectedForTracking(uid, '1z999aa10123456785', 'Estimated delivery: Fri, Nov 27', new Date('2026-11-20T20:00:00Z')), 1);
  const row = await get(o.id);
  assert.deepEqual([row.expectedDeliveryStart, row.expectedDeliverySource], [day('2026-11-27'), 'carrier']);
  assert.equal((await get(unrelated.id)).expectedDeliveryStart, null);
});
