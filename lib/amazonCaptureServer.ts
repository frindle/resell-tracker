// Database / HTTP wiring for lib/amazonIngest.ts. Kept apart so the ingest
// logic stays testable without a database.
import { NextRequest } from 'next/server';
import { parseHTML } from 'linkedom';
import { prisma, getSetting } from '@/lib/db';
import { parseAmazonPage, type AmazonPageKind } from '@/lib/amazonPageParse';
import { ingestPage, type IngestDeps, type ImportRowLike, type PageSummary } from '@/lib/amazonIngest';
import type { ExistingOrder } from '@/lib/amazonCompare';

export const APPLY_SETTING = 'amazon_capture_apply';
export const MAX_HTML_BYTES = 2_500_000;
export const MAX_FAILURES = 20;
const digits = (s: string) => s.replace(/\D/g, '');

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

async function loadExisting(userId: number, nums: string[]): Promise<Map<string, ExistingOrder>> {
  const out = new Map<string, ExistingOrder>();
  if (!nums.length) return out;
  const rows = await prisma.order.findMany({
    where: { userId, platform: 'Amazon', orderNumber: { in: nums } },
    include: { card: { include: { lastFours: true } }, _count: { select: { attachments: true } } },
  });
  for (const o of rows) {
    if (!o.orderNumber) continue;
    out.set(digits(o.orderNumber), {
      id: o.id, orderNumber: o.orderNumber, orderDate: o.orderDate, cost: o.cost,
      itemDescription: o.itemDescription, shippingAddress: o.shippingAddress,
      trackingNumbers: o.trackingNumbers, taxAmount: o.taxAmount, cardId: o.cardId,
      cardLast4s: o.card ? [o.card.last4, ...o.card.lastFours.map(l => l.last4)].filter((x): x is string => !!x) : [],
      noRushBonusPercent: o.noRushBonusPercent, locked: o.locked, cancelled: o.cancelled,
      userEditedFields: o.userEditedFields, hasPhoto: o._count.attachments > 0,
    });
  }
  return out;
}

export async function handleCapturedPage(req: NextRequest, userId: number, url: URL, kind: AmazonPageKind, html: string): Promise<PageSummary> {
  const { document } = parseHTML(html);
  const parsed = parseAmazonPage(document as unknown as Document, kind, url.toString());
  const apply = await isApplyMode(userId);
  const deps: IngestDeps = {
    applyMode: apply,
    now: new Date(),
    loadExisting: nums => loadExisting(userId, nums),
    savedCardLast4s: async () => {
      const cards = await prisma.creditCard.findMany({ where: { userId }, include: { lastFours: true } });
      return new Set(cards.flatMap(c => [c.last4, ...c.lastFours.map(l => l.last4)]).filter((x): x is string => !!x));
    },
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
    saveFailure: async (pageKind, reason) => {
      await prisma.amazonCaptureFailure.create({ data: { userId, pageKind, url: url.toString().slice(0, 300), reason, html } });
      const old = await prisma.amazonCaptureFailure.findMany({ where: { userId }, orderBy: { id: 'desc' }, skip: MAX_FAILURES, select: { id: true } });
      if (old.length) await prisma.amazonCaptureFailure.deleteMany({ where: { id: { in: old.map(o => o.id) } } });
    },
  };
  return ingestPage(parsed, deps);
}
