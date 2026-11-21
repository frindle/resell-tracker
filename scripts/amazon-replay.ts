/**
 * Replay stored Amazon page captures through the CURRENT parser.
 *
 * Re-parses every stored page (raw HTML kept 30 days in AmazonCapturePage) with
 * lib/amazonPageParse.ts as it is in this checkout, compares each parsed order
 * with the order's CURRENT stored values, and prints a per-field summary plus
 * every mismatch. Run it before and after a parser change to see the effect on
 * real history. Read-only: it writes nothing.
 *
 *   npm run amazon:replay -- [--days 30] [--user 1] [--json]
 *
 * Needs the production database file and `npx prisma generate`. Point it at a
 * COPY of the live DB (for example the nightly snapshot in /data/backups):
 *   DATABASE_URL=file:/path/to/copy.db npm run amazon:replay
 */
import { parseHTML } from 'linkedom';
import { prisma } from '../lib/db';
import { parseAmazonPage } from '../lib/amazonPageParse';
import { loadExistingAmazon, loadSavedCardLast4s } from '../lib/amazonExisting';
import { gunzipHtml, PAGE_RETENTION_DAYS } from '../lib/amazonPageArchive';
import { replayPage, replayReport } from '../lib/amazonReplay';
import type { Observation } from '../lib/amazonBacktest';

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const json = process.argv.includes('--json');
const days = Math.min(PAGE_RETENTION_DAYS, Math.max(1, Number(arg('days') ?? PAGE_RETENTION_DAYS) || PAGE_RETENTION_DAYS));
const userArg = arg('user') ? Number(arg('user')) : null;

async function main() {
  const since = new Date(Date.now() - days * 86400000);
  const pages = await prisma.amazonCapturePage.findMany({
    where: { createdAt: { gte: since }, htmlGz: { not: null }, ...(userArg != null ? { userId: userArg } : {}) },
    orderBy: { createdAt: 'asc' },
  });
  const obs: Observation[] = [];
  const cards = new Map<number, Set<string>>();
  let parsedPages = 0, failed = 0;
  for (const p of pages) {
    try {
      const html = gunzipHtml(p.htmlGz!);
      const { document } = parseHTML(html);
      const parsed = parseAmazonPage(document as unknown as Document, p.pageKind as 'orders' | 'detail' | 'tracking', p.url);
      if (parsed.blocked || parsed.parseFailed) { failed++; continue; }
      const existing = await loadExistingAmazon(p.userId, parsed.orders.map(o => o.orderNumber));
      if (!cards.has(p.userId)) cards.set(p.userId, await loadSavedCardLast4s(p.userId));
      obs.push(...replayPage(p.createdAt, parsed, existing, { savedCardLast4s: cards.get(p.userId)! }));
      parsedPages++;
    } catch (e) {
      failed++;
      console.error(`page ${p.id}: ${String(e).slice(0, 160)}`);
    }
  }
  const report = replayReport(obs);
  if (json) { console.log(JSON.stringify({ days, pages: pages.length, parsedPages, failed, ...report }, null, 1)); return; }

  console.log(`Replayed ${parsedPages} of ${pages.length} stored pages from the last ${days} days (${failed} failed or blocked) with the current parser.\n`);
  console.log('field'.padEnd(18) + 'checked  match  mismatch  blank-in-tracker  accuracy');
  for (const f of report.fields) {
    console.log(f.field.padEnd(18) + String(f.checked).padEnd(9) + String(f.matched).padEnd(7) + String(f.mismatched).padEnd(10) + String(f.filled).padEnd(18) + (f.matchPercent == null ? 'n/a' : `${f.matchPercent}%`));
  }
  console.log(`\n${report.verdict}`);
  if (report.mismatches.length) {
    console.log(`\n${report.mismatches.length} mismatches (order, field, stored, parsed):`);
    for (const m of report.mismatches) console.log(`  ${m.orderNumber}  ${m.field}  stored=${JSON.stringify(m.stored)}  parsed=${JSON.stringify(m.page)}`);
  }
}

main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
