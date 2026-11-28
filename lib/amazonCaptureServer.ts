// Database / HTTP wiring for lib/amazonIngest.ts. Kept apart so the ingest
// logic stays testable without a database.
import { NextRequest } from 'next/server';
import { parseHTML } from 'linkedom';
import { prisma, getSetting } from '@/lib/db';
import { parseAmazonPage, type AmazonPageKind } from '@/lib/amazonPageParse';
import { ingestPage, type IngestDeps, type ImportRowLike, type PageSummary } from '@/lib/amazonIngest';
import { loadExistingAmazon, loadSavedCardLast4s } from '@/lib/amazonExisting';
import { encodeChecks, type OrderCheck } from '@/lib/amazonBacktest';
import { archiveCapturedPage } from '@/lib/amazonPageArchive';
import { recordPackagesAndDryRun } from '@/lib/bfmrDryRun';
import { recordCapturedPage } from '@/lib/amazonVisitQueue';
import { recordImportSignals } from '@/lib/merchantDeliveryDb';
import { recordExpectedFromText } from '@/lib/expectedDeliveryDb';

export const APPLY_SETTING = 'amazon_capture_apply';
export const MAX_HTML_BYTES = 2_500_000;
export const MAX_FAILURES = 20;

export async function isApplyMode(userId: number): Promise<boolean> {
  return (await getSetting(userId, APPLY_SETTING))?.value === 'true';
}

export function validateAmazonUrl(raw: unknown): URL | null {
  if (typeof raw !== 'string') return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && u.hostname === 'www.amazon.com' ? u : null;
  } catch { return null; }
}

export function isPageKind(k: unknown): k is AmazonPageKind {
  return k === 'orders' || k === 'detail' || k === 'tracking';
}

export async function handleCapturedPage(req: NextRequest, userId: number, url: URL, kind: AmazonPageKind, html: string, opts: { fillTracking?: boolean } = {}): Promise<PageSummary> {
  const { document } = parseHTML(html);
  const parsed = parseAmazonPage(document as unknown as Document, kind, url.toString());
  const apply = await isApplyMode(userId);
  let recorded: OrderCheck[] = [];
  const deps: IngestDeps = {
    applyMode: apply,
    // Pages from the extension's tracking run (TRACK_AMAZON) fill in a blank
    // tracking number even in compare mode.
    fillTracking: opts.fillTracking === true,
    now: new Date(),
    loadExisting: nums => loadExistingAmazon(userId, nums),
    savedCardLast4s: () => loadSavedCardLast4s(userId),
    importRows: async (rows: ImportRowLike[]) => {
      // Reuse the existing import pipeline in-process, with the caller's own auth headers.
      const { POST } = await import('@/app/api/import/route');
      const headers = new Headers({ 'content-type': 'application/json' });
      for (const h of ['x-extension-user-id', 'x-extension-secret', 'cookie']) {
        const v = req.headers.get(h); if (v) headers.set(h, v);
      }
      const r = await POST(new NextRequest(new URL('/api/import', req.url), { method: 'POST', headers, body: JSON.stringify(rows) }));
      if (!r.ok) throw new Error(`import failed: ${r.status}`);
    },
    writeLog: async entries => {
      await prisma.amazonCaptureLog.createMany({
        data: entries.map(e => ({
          userId, pageKind: e.pageKind, orderNumber: e.orderNumber, action: e.action, applied: e.applied,
          changes: JSON.stringify(e.changes), discrepancies: JSON.stringify(e.discrepancies),
        })),
      });
    },
    recordChecks: async checks => { recorded = checks; },
    saveFailure: async (pageKind, reason) => {
      await prisma.amazonCaptureFailure.create({ data: { userId, pageKind, url: url.toString().slice(0, 300), reason, html } });
      const old = await prisma.amazonCaptureFailure.findMany({ where: { userId }, orderBy: { id: 'desc' }, skip: MAX_FAILURES, select: { id: true } });
      if (old.length) await prisma.amazonCaptureFailure.deleteMany({ where: { id: { in: old.map(o => o.id) } } });
    },
  };
  const sum = await ingestPage(parsed, deps);
  // Keep the raw page (gzipped, 30 days) with its per-field backtest summary. Never blocks capture.
  if (!sum.blocked && !sum.parseFailed) {
    await archiveCapturedPage(userId, { pageKind: kind, url: url.toString(), html, orderCount: parsed.orders.length, summary: encodeChecks(recorded) })
      .catch(e => console.error('[amazon-backtest] archive failed:', String(e).slice(0, 160)));
  }
  // Amazon's own delivered date for its own deliveries (FedEx / UPS numbers are left to the carrier's page).
  const delivered = parsed.orders.filter(o => o.deliveredText && o.trackingNumbers.length);
  if (delivered.length) {
    await recordImportSignals(userId, delivered.map(o => ({
      platform: 'Amazon', orderNumber: o.orderNumber, trackingNumbers: o.trackingNumbers, deliveredText: o.deliveredText,
    }))).catch(e => console.error('[carrier-delivery] record failed:', String(e).slice(0, 160)));
  }
  // The merchant's expected delivery ("Arriving Nov 30"), read relative to the capture time. Written after the
  // ingest so a newly created order exists; the newest sighting wins (lib/expectedDelivery.ts).
  const expecting = parsed.orders.filter(o => o.expectedText);
  if (expecting.length) await recordExpectedFromText(userId, 'amazon-page', expecting.map(o => ({ orderNumber: o.orderNumber, text: o.expectedText })), deps.now);
  // Package capture + BFMR dry run, then the guarded BFMR tracking auto-submit
  // (setting `bfmr_auto_submit`: off / plan (default) / on). Never throws here.
  await recordPackagesAndDryRun(userId, parsed).catch(e => console.error('[bfmr-dry-run] record failed:', String(e).slice(0, 160)));
  // Tell the visit queue (lib/amazonVisitQueue.ts) what this page covered.
  await recordCapturedPage(userId, {
    kind, ok: !sum.blocked && !sum.parseFailed,
    orderNumber: sum.captured?.orderNumber, hasTracking: sum.captured?.hasTracking,
    applied: sum.mode === 'apply',
  }).catch(e => console.error('[amazon-visits] record failed:', String(e).slice(0, 160)));
  return sum;
}
