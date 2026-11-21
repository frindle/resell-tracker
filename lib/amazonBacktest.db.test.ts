// DB-level test of the page archive: gzip storage, size cap, 30-day pruning and the report read path,
// against a real SQLite file. Run with `npm run test:amazon-backtest-db` (needs `prisma generate`).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'amazon-backtest-db-'));
process.env.DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
execFileSync('npx', ['prisma', 'migrate', 'deploy'], { env: process.env, stdio: 'pipe' });

const { prisma } = await import('./db.ts');
const { archiveCapturedPage, pruneAmazonPages, gunzipHtml, MAX_ARCHIVE_HTML_CHARS } = await import('./amazonPageArchive.ts');
const { encodeChecks, buildReport } = await import('./amazonBacktest.ts');

let userId = 0;
const DAY = 86400000;
const NOW = new Date('2026-11-20T12:00:00Z');
const summary = (status: 'match' | 'mismatch') => encodeChecks([{
  orderNumber: '111-2222222-3333331', fields: { cost: status },
  mismatches: status === 'mismatch' ? [{ field: 'cost', stored: 10, page: 12 }] : [],
}]);

before(async () => { userId = (await prisma.user.create({ data: { name: 'backtest-test' } })).id; });
after(async () => { await prisma.$disconnect(); rmSync(dir, { recursive: true, force: true }); });

test('a captured page is stored gzipped and round-trips exactly', async () => {
  const html = '<html><body>' + 'Order 111-2222222-3333331 at 100 Example St, Testville, ZZ 00000 '.repeat(500) + '</body></html>';
  await archiveCapturedPage(userId, { pageKind: 'detail', url: 'https://www.amazon.com/example', html, orderCount: 1, summary: summary('match') });
  const row = await prisma.amazonCapturePage.findFirstOrThrow({ where: { userId } });
  assert.equal(gunzipHtml(row.htmlGz!), html);
  assert.equal(row.rawBytes, html.length);
  assert.ok(row.htmlGz!.length < html.length / 5, 'compressed');
  await prisma.amazonCapturePage.deleteMany({});
});

test('a page over the size cap keeps its summary but not its HTML', async () => {
  await archiveCapturedPage(userId, { pageKind: 'orders', url: 'https://www.amazon.com/example', html: 'x'.repeat(MAX_ARCHIVE_HTML_CHARS + 1), orderCount: 1, summary: summary('match') });
  const row = await prisma.amazonCapturePage.findFirstOrThrow({ where: { userId } });
  assert.equal(row.htmlGz, null);
  assert.equal(row.summary, summary('match'));
  await prisma.amazonCapturePage.deleteMany({});
});

test('pruning removes pages older than 30 days and keeps newer ones', async () => {
  const mk = (ageDays: number) => prisma.amazonCapturePage.create({
    data: { userId, pageKind: 'detail', url: 'https://www.amazon.com/example', rawBytes: 1, summary: summary('match'), createdAt: new Date(NOW.getTime() - ageDays * DAY) },
  });
  await mk(31); await mk(45); await mk(29); await mk(1);
  const removed = await pruneAmazonPages(NOW);
  assert.equal(removed, 2);
  const left = await prisma.amazonCapturePage.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
  assert.equal(left.length, 2);
  assert.ok(left.every(r => NOW.getTime() - r.createdAt.getTime() < 30 * DAY));
});

test('the report reads summaries from stored rows', async () => {
  await prisma.amazonCapturePage.deleteMany({});
  await prisma.amazonCapturePage.create({ data: { userId, pageKind: 'detail', url: 'https://www.amazon.com/example', rawBytes: 1, summary: summary('mismatch'), createdAt: new Date(NOW.getTime() - DAY) } });
  const rows = await prisma.amazonCapturePage.findMany({ where: { userId }, select: { createdAt: true, summary: true } });
  const r = buildReport(rows);
  assert.equal(r.fields.find(f => f.field === 'cost')!.mismatched, 1);
  assert.equal(r.ready, false);
});
