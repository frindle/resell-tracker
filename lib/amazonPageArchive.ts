// Keeps each captured Amazon page's raw HTML (gzipped) for 30 days, with the
// per-field backtest summary, in one row per capture. Pruned automatically.
// Failures here must never break capture: callers catch.
import { gzipSync, gunzipSync } from 'node:zlib';
import { prisma } from '@/lib/db';

export const PAGE_RETENTION_DAYS = 30;
/** Same per-page cap as the capture endpoint (app/api/extension/amazon-page rejects bigger pages). */
export const MAX_ARCHIVE_HTML_CHARS = 2_500_000;

export const gzipHtml = (html: string): Buffer => gzipSync(Buffer.from(html, 'utf8'), { level: 9 });
export const gunzipHtml = (buf: Uint8Array): string => gunzipSync(buf).toString('utf8');
export const retentionCutoff = (now: Date, days = PAGE_RETENTION_DAYS): Date => new Date(now.getTime() - days * 86400000);

export async function archiveCapturedPage(userId: number, p: { pageKind: string; url: string; html: string; orderCount: number; summary: string }): Promise<void> {
  // An over-cap page keeps its summary (the accuracy count) but not its HTML.
  const keep = p.html.length <= MAX_ARCHIVE_HTML_CHARS;
  await prisma.amazonCapturePage.create({
    data: {
      userId, pageKind: p.pageKind, url: p.url.slice(0, 300), orderCount: p.orderCount, summary: p.summary,
      rawBytes: p.html.length, htmlGz: keep ? new Uint8Array(gzipHtml(p.html)) : null,
    },
  });
}

export async function pruneAmazonPages(now = new Date(), days = PAGE_RETENTION_DAYS): Promise<number> {
  const { count } = await prisma.amazonCapturePage.deleteMany({ where: { createdAt: { lt: retentionCutoff(now, days) } } });
  return count;
}

export function startAmazonPageRetention(): void {
  const run = () => pruneAmazonPages()
    .then(n => { if (n > 0) console.log(`[amazonPage] pruned ${n} captured pages older than ${PAGE_RETENTION_DAYS}d`); })
    .catch(e => console.error('[amazonPage] prune failed:', String(e).slice(0, 200)));
  run();
  setInterval(run, 6 * 60 * 60 * 1000);
}
