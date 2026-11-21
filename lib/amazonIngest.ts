// Orchestrates one captured Amazon page: parse result -> compare -> (apply via
// the existing /api/import path) -> log. All side effects go through `deps`,
// so the compare-only guarantee ("writes nothing but the log") is testable.
import type { ParsedPage, ParsedOrder } from './amazonPageParse.ts';
import { compareOrder, type ExistingOrder, type OrderAction } from './amazonCompare.ts';
import { checkOrderFields, type OrderCheck } from './amazonBacktest.ts';

export const WINDOW_DAYS = 14;
export const MAX_NEEDS = 40;

export interface ImportRowLike {
  platform: 'Amazon';
  orderNumber: string;
  orderDate: string;
  itemDescription: string;
  cost: number;
  shippingCost: number;
  salePrice: null;
  buyerId: string;
  cardId: string;
  cashbackAmount: number;
  sourceUrl?: string;
  shippingAddress?: string;
  trackingNumbers?: string[];
  paymentLast4?: string;
  paymentRatePercent?: number;
  taxAmount?: number | null;
  subtotalAmount?: number | null;
  noRushBonusPercent?: number;
  deliveryPhotoUrl?: string;
}

export interface LogEntry {
  pageKind: string;
  orderNumber: string;
  action: string;
  applied: boolean;
  changes: unknown[];
  discrepancies: unknown[];
}

export interface IngestDeps {
  applyMode: boolean;
  /** Compare mode still saves a blank order's tracking number (the extension's TRACK_AMAZON run). */
  fillTracking?: boolean;
  now: Date;
  loadExisting(orderNumbers: string[]): Promise<Map<string, ExistingOrder>>; // keyed by digits-only order number
  savedCardLast4s(): Promise<Set<string>>;
  importRows(rows: ImportRowLike[]): Promise<void>;
  writeLog(entries: LogEntry[]): Promise<void>;
  /** Backtest measurement (lib/amazonBacktest.ts): per-field match/mismatch for every compared order. Measurement only; never alters what is applied. */
  recordChecks?(checks: OrderCheck[]): Promise<void>;
  saveFailure(pageKind: string, reason: string): Promise<void>;
}

export interface NeedItem { orderNumber: string; detailUrl?: string | null; trackUrls?: string[] }
export interface PageSummary {
  created: number; updated: number; unchanged: number; discrepancies: number;
  mode: 'compare' | 'apply';
  blocked?: boolean; parseFailed?: boolean;
  list?: { nextUrl: string | null; reachedWindow: boolean; allComplete: boolean; needs: NeedItem[]; /** Some order on this page is already in the tracker: the run need not page further back. */ anyKnown?: boolean };
  /** Detail page of an order still without tracking: its Track package links, for the extension's tracking run. */
  detail?: { orderNumber: string; trackUrls: string[]; hasTracking?: boolean };
  /** The order a detail or tracking page was about, for the visit queue (lib/amazonVisitQueue.ts). */
  captured?: { orderNumber: string; hasTracking: boolean };
}

const digits = (s: string) => s.replace(/\D/g, '');
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export function buildImportRow(page: ParsedOrder, existing: ExistingOrder | null, action: OrderAction): ImportRowLike {
  const has = (f: string) => action.changes.some(c => c.field === f);
  const create = existing === null;
  const row: ImportRowLike = {
    platform: 'Amazon',
    orderNumber: page.orderNumber,
    orderDate: create ? page.orderDate! : isoDay(existing!.orderDate),
    itemDescription: create || has('itemDescription') ? (page.itemDescription ?? '') : (existing!.itemDescription ?? ''),
    cost: create ? page.cost! : existing!.cost,
    shippingCost: 0, salePrice: null, buyerId: '', cardId: '', cashbackAmount: 0,
    sourceUrl: page.detailUrl ?? `https://www.amazon.com/gp/your-account/order-details?orderID=${page.orderNumber}`,
  };
  if (create || has('shippingAddress')) row.shippingAddress = page.shippingAddress;
  if (create || has('trackingNumbers')) row.trackingNumbers = page.trackingNumbers;
  if (create || has('cardId')) { row.paymentLast4 = page.paymentLast4; row.paymentRatePercent = page.paymentRatePercent; }
  if (create || has('taxAmount')) {
    row.taxAmount = page.taxAmount ?? null;
    row.subtotalAmount = page.subtotalAmount ?? null;
  }
  if (create || has('noRushBonusPercent')) row.noRushBonusPercent = page.noRushBonusPercent;
  if (create || has('deliveryPhotoUrl')) row.deliveryPhotoUrl = page.deliveryPhotoUrl;
  return row;
}

export async function ingestPage(parsed: ParsedPage, deps: IngestDeps): Promise<PageSummary> {
  const mode = deps.applyMode ? 'apply' : 'compare';
  const sum: PageSummary = { created: 0, updated: 0, unchanged: 0, discrepancies: 0, mode };
  if (parsed.blocked) { sum.blocked = true; return sum; }
  if (parsed.parseFailed) {
    sum.parseFailed = true;
    await deps.saveFailure(parsed.kind, 'no data parsed from page');
    return sum;
  }

  const existingMap = await deps.loadExisting(parsed.orders.map(o => o.orderNumber));
  const cardSet = await deps.savedCardLast4s();
  const rows: ImportRowLike[] = [];
  const log: LogEntry[] = [];
  const needs: NeedItem[] = [];
  const checks: OrderCheck[] = [];
  let allComplete = parsed.orders.length > 0;

  for (const page of parsed.orders) {
    const existing = existingMap.get(digits(page.orderNumber)) ?? null;
    const action = compareOrder(page, existing, { savedCardLast4s: cardSet });

    if (action.action === 'create') sum.created++;
    else if (action.action === 'fill') sum.updated++;
    else sum.unchanged++;
    if (action.discrepancies.length) sum.discrepancies++;

    const check = checkOrderFields(page, existing, { savedCardLast4s: cardSet }, action);
    if (check && Object.keys(check.fields).length) checks.push(check);

    if (action.needsDetail) {
      allComplete = false;
      needs.push({ orderNumber: page.orderNumber, detailUrl: page.detailUrl ?? null, trackUrls: !existing || !existing.trackingNumbers ? page.trackUrls : [] });
    }

    const trackingFill = !deps.applyMode && deps.fillTracking && existing && action.action === 'fill'
      ? action.changes.filter(c => c.field === 'trackingNumbers') : [];
    if (deps.applyMode && (action.action === 'create' || action.action === 'fill')) {
      rows.push(buildImportRow(page, existing, action));
    } else if (trackingFill.length) {
      rows.push(buildImportRow(page, existing, { ...action, changes: trackingFill }));
    }
    if (action.action !== 'unchanged' || action.discrepancies.length) {
      log.push({
        pageKind: parsed.kind, orderNumber: page.orderNumber, action: action.action,
        applied: (deps.applyMode && (action.action === 'create' || action.action === 'fill')) || trackingFill.length > 0,
        changes: action.changes, discrepancies: action.discrepancies,
      });
    }
  }

  if (rows.length) await deps.importRows(rows);
  if (log.length) await deps.writeLog(log);
  // Measured before anything is applied (existing was loaded above), and a failure here never affects capture.
  if (deps.recordChecks) await deps.recordChecks(checks).catch(e => console.error('[amazon-backtest] record failed:', String(e).slice(0, 160)));

  if (parsed.kind === 'detail' && parsed.orders[0]) {
    const page = parsed.orders[0];
    const existing = existingMap.get(digits(page.orderNumber)) ?? null;
    const has = (page.trackingNumbers?.length ?? 0) > 0 || !!existing?.trackingNumbers;
    sum.detail = { orderNumber: page.orderNumber, trackUrls: has ? [] : (page.trackUrls ?? []).slice(0, 3), hasTracking: has };
  }

  if ((parsed.kind === 'detail' || parsed.kind === 'tracking') && parsed.orders[0]) {
    const page = parsed.orders[0];
    const existing = existingMap.get(digits(page.orderNumber)) ?? null;
    sum.captured = { orderNumber: page.orderNumber, hasTracking: (page.trackingNumbers?.length ?? 0) > 0 || !!existing?.trackingNumbers };
  }

  if (parsed.kind === 'orders') {
    const cutoff = isoDay(new Date(deps.now.getTime() - WINDOW_DAYS * 86400000));
    sum.list = {
      nextUrl: parsed.nextUrl ?? null,
      reachedWindow: !!parsed.oldestDate && parsed.oldestDate < cutoff,
      allComplete,
      needs: needs.slice(0, MAX_NEEDS),
      anyKnown: existingMap.size > 0,
    };
  }
  return sum;
}
