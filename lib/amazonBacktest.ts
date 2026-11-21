// Backtest measurement for Amazon page capture. Pure: no database, no network.
//
// For every order compared from a captured page we record, per field, whether
// the page agreed with what the tracker already stored:
//   match     the tracker had a value and the page agrees
//   mismatch  the tracker had a value and the page disagrees
//   filled    the tracker was blank and the page supplied a value
// Only match/mismatch count toward accuracy: a filled value came from the page
// itself, so checking it against the page later would only measure itself.
// This is measurement only; it never changes what compare or apply mode writes.
import type { ParsedOrder } from './amazonPageParse.ts';
import { compareOrder, type ExistingOrder, type CompareContext, type OrderAction } from './amazonCompare.ts';
import { taxFields } from './amazonTax.ts';
import { isReplaceableDescription } from './gapFill.ts';

export const BACKTEST_FIELDS = ['orderDate', 'cost', 'itemDescription', 'shippingAddress', 'card', 'taxAmount', 'trackingNumbers'] as const;
export type BacktestField = typeof BACKTEST_FIELDS[number];
export type FieldStatus = 'match' | 'mismatch' | 'filled';

export const MIN_CHECKED = 30;
export const MIN_MATCH_PERCENT = 98;
export const MAX_REPORT_DAYS = 30;

export interface FieldMismatch { field: BacktestField; stored: unknown; page: unknown }
export interface OrderCheck {
  orderNumber: string;
  fields: Partial<Record<BacktestField, FieldStatus>>;
  mismatches: FieldMismatch[];
}

const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** Titles are compared loosely: list pages truncate, and the tracker keeps what the user typed. */
export function titlesAgree(stored: string, page: string): boolean {
  const a = norm(stored), b = norm(page);
  if (!a || !b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  const n = Math.min(24, a.length, b.length);
  return a.slice(0, n) === b.slice(0, n);
}

/** Per-field results for one page order. null when the order is not stored or is locked (compare skips it, so nothing is checked). */
export function checkOrderFields(page: ParsedOrder, existing: ExistingOrder | null, ctx: CompareContext, action?: OrderAction): OrderCheck | null {
  if (!existing || existing.locked) return null;
  const act = action ?? compareOrder(page, existing, ctx);
  const out: OrderCheck = { orderNumber: page.orderNumber, fields: {}, mismatches: [] };
  const discrepancy = (f: string) => act.discrepancies.find(d => d.field === f);
  const filled = (f: string) => act.changes.some(c => c.field === f);
  const set = (field: BacktestField, status: FieldStatus, stored?: unknown, pageVal?: unknown) => {
    out.fields[field] = status;
    if (status === 'mismatch') out.mismatches.push({ field, stored, page: pageVal });
  };
  // Both sides present: match unless compare reported a discrepancy.
  const both = (field: BacktestField, cmpField: string, stored: unknown, pageVal: unknown) => {
    const d = discrepancy(cmpField);
    if (d) set(field, 'mismatch', d.stored, d.page); else set(field, 'match', stored, pageVal);
  };
  // Stored side blank: only a proposed fill is recorded (a hand-edited field has none, so it is skipped).
  const blank = (field: BacktestField, cmpField: string) => { if (filled(cmpField)) set(field, 'filled'); };

  if (page.orderDate) both('orderDate', 'orderDate', isoDay(existing.orderDate), page.orderDate);
  if (page.cost && existing.cost > 0) both('cost', 'cost', existing.cost, page.cost);

  if (page.itemDescription) {
    if (isReplaceableDescription(existing.itemDescription)) blank('itemDescription', 'itemDescription');
    else if (titlesAgree(existing.itemDescription!, page.itemDescription)) set('itemDescription', 'match');
    else set('itemDescription', 'mismatch', existing.itemDescription, page.itemDescription);
  }

  if (page.shippingAddress) {
    if (!existing.shippingAddress) blank('shippingAddress', 'shippingAddress');
    else both('shippingAddress', 'shippingAddress', existing.shippingAddress, page.shippingAddress);
  }

  if (page.paymentLast4) {
    if (existing.cardId == null) blank('card', 'cardId');
    else if (existing.cardLast4s.length) both('card', 'card', `ending ${existing.cardLast4s.join('/')}`, `ending ${page.paymentLast4}`);
  }

  const tax = page.cost ? taxFields(page.cost, page.taxAmount ?? null) : {};
  if (tax.taxAmount !== undefined) {
    if (existing.taxAmount == null) blank('taxAmount', 'taxAmount');
    else both('taxAmount', 'taxAmount', existing.taxAmount, tax.taxAmount);
  }

  if (page.trackingNumbers.length) {
    if (!existing.trackingNumbers) blank('trackingNumbers', 'trackingNumbers');
    else both('trackingNumbers', 'trackingNumbers', existing.trackingNumbers, page.trackingNumbers.join(','));
  }
  return out;
}

// ---- compact storage: one JSON string per page capture --------------------
// {"v":1,"o":[[orderNumber,{field:"m"|"x"|"f"},[[field,stored,page],...]],...]}
const CODE: Record<FieldStatus, string> = { match: 'm', mismatch: 'x', filled: 'f' };
const DECODE: Record<string, FieldStatus> = { m: 'match', x: 'mismatch', f: 'filled' };
const MAX_VALUE_CHARS = 200;
const clip = (v: unknown) => (typeof v === 'string' && v.length > MAX_VALUE_CHARS ? v.slice(0, MAX_VALUE_CHARS) : v ?? null);

export function encodeChecks(checks: OrderCheck[]): string {
  return JSON.stringify({
    v: 1,
    o: checks.map(c => [
      c.orderNumber,
      Object.fromEntries(Object.entries(c.fields).map(([f, s]) => [f, CODE[s as FieldStatus]])),
      c.mismatches.map(m => [m.field, clip(m.stored), clip(m.page)]),
    ]),
  });
}

export function decodeChecks(json: string): OrderCheck[] {
  let data: { o?: unknown };
  try { data = JSON.parse(json); } catch { return []; }
  if (!data || !Array.isArray(data.o)) return [];
  const known = new Set<string>(BACKTEST_FIELDS);
  const out: OrderCheck[] = [];
  for (const row of data.o as unknown[]) {
    if (!Array.isArray(row) || typeof row[0] !== 'string') continue;
    const fields: OrderCheck['fields'] = {};
    for (const [f, code] of Object.entries((row[1] ?? {}) as Record<string, string>)) {
      if (known.has(f) && DECODE[code]) fields[f as BacktestField] = DECODE[code];
    }
    const mismatches: FieldMismatch[] = [];
    for (const m of (Array.isArray(row[2]) ? row[2] : []) as unknown[][]) {
      if (Array.isArray(m) && known.has(String(m[0]))) mismatches.push({ field: m[0] as BacktestField, stored: m[1], page: m[2] });
    }
    out.push({ orderNumber: row[0], fields, mismatches });
  }
  return out;
}

// ---- report math ------------------------------------------------------------
export interface Observation { at: Date; orderNumber: string; field: BacktestField; status: FieldStatus; stored?: unknown; page?: unknown }

export function observationsOf(at: Date, checks: OrderCheck[]): Observation[] {
  const out: Observation[] = [];
  for (const c of checks) {
    for (const f of BACKTEST_FIELDS) {
      const status = c.fields[f];
      if (!status) continue;
      const m = c.mismatches.find(x => x.field === f);
      out.push({ at, orderNumber: c.orderNumber, field: f, status, stored: m?.stored, page: m?.page });
    }
  }
  return out;
}

export interface FieldReport { field: BacktestField; checked: number; matched: number; mismatched: number; filled: number; matchPercent: number | null; ok: boolean }
export interface MismatchRow { orderNumber: string; field: BacktestField; stored: unknown; page: unknown; at: string }
export interface Report {
  fields: FieldReport[]; mismatches: MismatchRow[]; ready: boolean; verdict: string;
}

/**
 * Each (order, field) counts once, by its latest observation, so re-visiting an
 * order does not inflate the denominator. With excludeEverFilled (live log), a
 * pair the page ever filled is not counted as checked: the tracker's value
 * came from the page. Replay compares against current stored values, so it
 * leaves that off.
 */
export function tally(obs: Observation[], opts: { excludeEverFilled: boolean }): Report {
  const sorted = [...obs].sort((a, b) => a.at.getTime() - b.at.getTime());
  const latest = new Map<string, Observation>();
  const everFilled = new Set<string>();
  for (const o of sorted) {
    const key = `${o.orderNumber}|${o.field}`;
    if (o.status === 'filled') everFilled.add(key);
    latest.set(key, o);
  }
  const fields: FieldReport[] = BACKTEST_FIELDS.map(field => ({ field, checked: 0, matched: 0, mismatched: 0, filled: 0, matchPercent: null, ok: false }));
  const byField = new Map(fields.map(f => [f.field, f]));
  const mismatches: MismatchRow[] = [];
  for (const [key, o] of latest) {
    const fr = byField.get(o.field)!;
    if (o.status === 'filled' || (opts.excludeEverFilled && everFilled.has(key))) { fr.filled++; continue; }
    fr.checked++;
    if (o.status === 'match') fr.matched++;
    else { fr.mismatched++; mismatches.push({ orderNumber: o.orderNumber, field: o.field, stored: o.stored ?? null, page: o.page ?? null, at: o.at.toISOString() }); }
  }
  for (const f of fields) {
    f.matchPercent = f.checked ? Math.round((f.matched / f.checked) * 1000) / 10 : null;
    f.ok = f.checked >= MIN_CHECKED && f.matched * 100 >= MIN_MATCH_PERCENT * f.checked;
  }
  mismatches.sort((a, b) => b.at.localeCompare(a.at) || a.orderNumber.localeCompare(b.orderNumber) || a.field.localeCompare(b.field));
  const bad = fields.filter(f => !f.ok);
  const ready = bad.length === 0;
  const verdict = ready
    ? `ready: every field has at least ${MIN_CHECKED} checked values and ${MIN_MATCH_PERCENT}% or better match`
    : 'not ready: ' + bad.map(f => f.checked < MIN_CHECKED ? `${f.field} ${f.checked}/${MIN_CHECKED} checked` : `${f.field} ${f.matchPercent}% match`).join(', ');
  return { fields, mismatches, ready, verdict };
}

/** Live report: stored page-capture rows -> report. */
export function buildReport(rows: { createdAt: Date; summary: string }[]): Report & { pages: number } {
  const obs = rows.flatMap(r => observationsOf(r.createdAt, decodeChecks(r.summary)));
  return { ...tally(obs, { excludeEverFilled: true }), pages: rows.length };
}
