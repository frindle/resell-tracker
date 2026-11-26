// Bloom Ledger monthly "mock invoice": the Darkbloom side hustle as one income line per month in the P&L.
// The resell-tracker PULLS these from the read-only bloom-ledger endpoints (env BLOOM_LEDGER_URL; off when unset), the
// same address the books' tally reader uses. One row per (user, month): a re-run updates it, never adds a second.
// Money is integer cents. Nothing here touches the database; lib/bloomInvoiceService.ts wires it to Prisma.

export type InvoiceLine = { key: string; label: string; amountCents: number; count: number; tokens: number };
export type InvoiceCost = { key: string; label: string; amountCents: number | null };
export type InvoiceUsage = { tokens: number | null; jobs: number | null; inferenceMinutes: number | null; sandboxMinutes: number | null; vcpuSeconds: number | null };
export type BloomInvoice = {
  month: string; invoiceId: string; issueDate: string; currency: string; final: boolean; hash: string;
  grossCents: number; feesCents: number | null; feesNote: string | null; otherIncomeCents: number;
  lines: InvoiceLine[]; costs: InvoiceCost[]; costsUnknown: string[];
  netCents: number; usage: InvoiceUsage; machineCount: number;
};
/** What the P&L needs from one stored invoice. toDate: a month still running, read live from the ledger (not stored, not final). */
export type InvoiceMoney = { month: string; grossCents: number; otherIncomeCents: number; feesCents: number; costsCents: number; netCents: number; toDate?: boolean };

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const intOrNull = (v: unknown): number | null => (isInt(v) ? v : null);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown, max = 200): string => (typeof v === 'string' ? v.slice(0, max) : '');

/** Net the way the P&L counts it: gross + other income - fees (0 when unknown) - every cost the ledger could compute.
 *  Gross is what the work cost the buyers and fees is Darkbloom's cut of it, so the fee comes off exactly once. */
export function netCents(gross: number, other: number, fees: number | null, costs: (number | null)[]): number {
  return gross + other - (fees ?? 0) - costs.reduce<number>((s, c) => s + (c ?? 0), 0);
}

/** Validate the ledger's invoice JSON. The net is recomputed here, so a wrong net in the payload cannot reach the P&L. */
export function parseInvoice(raw: unknown, expectMonth?: string): { ok: BloomInvoice } | { error: string } {
  const r = rec(raw);
  const month = str(r.month, 7);
  if (!MONTH_RE.test(month)) return { error: 'invoice has no valid month' };
  if (expectMonth && month !== expectMonth) return { error: `invoice is for ${month}, expected ${expectMonth}` };
  if (!isInt(r.gross_cents) || r.gross_cents < 0) return { error: 'invoice has no valid gross_cents' };
  if (typeof r.hash !== 'string' || !r.hash) return { error: 'invoice has no hash' };
  const other = isInt(r.other_income_cents) ? r.other_income_cents : 0;
  const fees = intOrNull(r.fees_cents);
  if (!Array.isArray(r.lines)) return { error: 'invoice has no lines' };
  const lines: InvoiceLine[] = [];
  for (const l of r.lines) {
    const x = rec(l);
    if (!isInt(x.amount_cents)) return { error: 'invoice line has no amount_cents' };
    lines.push({ key: str(x.key, 40), label: str(x.label, 80), amountCents: x.amount_cents, count: isInt(x.count) ? x.count : 0, tokens: isInt(x.tokens) ? x.tokens : 0 });
  }
  const costs: InvoiceCost[] = (Array.isArray(r.costs) ? r.costs : []).map(c => {
    const x = rec(c);
    return { key: str(x.key, 40), label: str(x.label, 80), amountCents: intOrNull(x.amount_cents) };
  });
  const u = rec(r.usage);
  return {
    ok: {
      month, invoiceId: str(r.invoice_id, 40) || `BL-${month}`, issueDate: str(r.issue_date, 10), currency: str(r.currency, 3) || 'USD',
      final: r.final === true, hash: r.hash,
      grossCents: r.gross_cents, feesCents: fees, feesNote: str(r.fees_note, 300) || null, otherIncomeCents: other,
      lines, costs, costsUnknown: (Array.isArray(r.costs_unknown) ? r.costs_unknown : []).map(k => str(k, 40)),
      netCents: netCents(r.gross_cents, other, fees, costs.map(c => c.amountCents)),
      usage: { tokens: intOrNull(u.tokens), jobs: intOrNull(u.jobs), inferenceMinutes: intOrNull(u.inference_minutes), sandboxMinutes: intOrNull(u.sandbox_minutes), vcpuSeconds: intOrNull(u.vcpu_seconds) },
      machineCount: isInt(r.machine_count) ? r.machine_count : 0,
    },
  };
}

export function invoiceMoney(inv: BloomInvoice): InvoiceMoney {
  return {
    month: inv.month, grossCents: inv.grossCents, otherIncomeCents: inv.otherIncomeCents, feesCents: inv.feesCents ?? 0,
    costsCents: inv.costs.reduce((s, c) => s + (c.amountCents ?? 0), 0), netCents: inv.netCents,
  };
}

/** A month not yet final (the one running, or one just ended that the ledger has not closed), read live: the ledger tallies
 *  it through today, with power, depreciation and lease to date, so this is Bloom's month to date. Throws on any failure. */
export async function fetchMonthToDate(
  opts: { baseUrl: string; month: string; fetchFn?: typeof fetch; timeoutMs?: number },
): Promise<InvoiceMoney> {
  const f = opts.fetchFn ?? fetch;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 10_000);
  let body: unknown;
  try {
    const res = await f(`${opts.baseUrl.replace(/\/+$/, '')}/v1/invoice/monthly?month=${encodeURIComponent(opts.month)}`, { signal: ctl.signal });
    if (!res.ok) throw new Error(`ledger answered HTTP ${res.status}`);
    body = await res.json();
  } finally {
    clearTimeout(timer);
  }
  const parsed = parseInvoice(body, opts.month);
  if ('error' in parsed) throw new Error(parsed.error);
  return { ...invoiceMoney(parsed.ok), toDate: !parsed.ok.final };
}

export type StoredInvoice = InvoiceMoney & { hash: string; payload: string };
export interface InvoiceRows {
  /** The stored invoice's hash, or null when the month has none. */
  getHash(userId: number, month: string): Promise<string | null>;
  /** Insert or update the one row for (user, month). */
  upsert(userId: number, row: StoredInvoice): Promise<void>;
}
export type InvoiceSyncResult = { checked: number; created: number; updated: number; unchanged: number; skippedNonFinal: number; errors: string[] } | { disabled: true };

/** Pull every final month the ledger lists and store it. A month whose hash matches what is stored is left alone, so
 *  running this again, daily or on demand, changes nothing; a changed hash (a correction) updates the same row. */
export async function syncInvoices(
  rows: InvoiceRows, userId: number,
  opts: { baseUrl: string | undefined; fetchFn?: typeof fetch; timeoutMs?: number; maxMonths?: number },
): Promise<InvoiceSyncResult> {
  if (!opts.baseUrl) return { disabled: true };
  const f = opts.fetchFn ?? fetch;
  const base = opts.baseUrl.replace(/\/+$/, '');
  const out = { checked: 0, created: 0, updated: 0, unchanged: 0, skippedNonFinal: 0, errors: [] as string[] };
  const getJson = async (url: string): Promise<unknown> => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 20_000);
    try {
      const res = await f(url, { signal: ctl.signal });
      if (!res.ok) throw new Error(`ledger answered HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  };
  let months: { month: string; final: boolean; hash: string }[];
  try {
    const idx = rec(await getJson(`${base}/v1/invoice/months`));
    if (!Array.isArray(idx.months)) throw new Error('ledger index has no months list');
    months = idx.months.map(m => ({ month: str(rec(m).month, 7), final: rec(m).final === true, hash: str(rec(m).hash, 80) }));
  } catch (e) {
    out.errors.push(`index: ${e instanceof Error ? e.message : String(e)}`);
    return out;
  }
  for (const m of months.filter(x => MONTH_RE.test(x.month)).slice(-(opts.maxMonths ?? 36))) {
    if (!m.final) { out.skippedNonFinal++; continue; }
    out.checked++;
    try {
      const have = await rows.getHash(userId, m.month);
      if (have !== null && have === m.hash) { out.unchanged++; continue; }
      const parsed = parseInvoice(await getJson(`${base}/v1/invoice/monthly?month=${encodeURIComponent(m.month)}`), m.month);
      if ('error' in parsed) throw new Error(parsed.error);
      const inv = parsed.ok;
      if (!inv.final) { out.skippedNonFinal++; continue; }
      await rows.upsert(userId, { ...invoiceMoney(inv), hash: inv.hash, payload: JSON.stringify(inv) });
      if (have === null) out.created++; else out.updated++;
    } catch (e) {
      out.errors.push(`${m.month}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}

// ---- P&L ----

/** months: whole invoiced months counted; toDate: months still running counted to date. */
export type BloomPnl = { grossCents: number; otherIncomeCents: number; feesCents: number; costsCents: number; netCents: number; months: number; toDate: number };
const ZERO: BloomPnl = { grossCents: 0, otherIncomeCents: 0, feesCents: 0, costsCents: 0, netCents: 0, months: 0, toDate: 0 };

const key = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const lastDay = (month: string) => `${month}-${String(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate()).padStart(2, '0')}`;

/** Bloom's P&L for a period. An invoiced month counts when the whole month lies inside the period (service month, not the
 *  day the invoice was issued). A month to date (toDate) counts when the period holds its 1st: its figures run only
 *  through today, so a period that starts on or before the 1st and has reached it covers everything it has so far. */
export function bloomInRange(invoices: InvoiceMoney[], start: Date, end: Date): BloomPnl {
  const a = key(start), b = key(end);
  const out = { ...ZERO };
  for (const i of invoices) {
    if (`${i.month}-01` < a || (i.toDate ? `${i.month}-01` > b : lastDay(i.month) > b)) continue;
    out.grossCents += i.grossCents; out.otherIncomeCents += i.otherIncomeCents; out.feesCents += i.feesCents;
    out.costsCents += i.costsCents; out.netCents += i.netCents;
    if (i.toDate) out.toDate++; else out.months++;
  }
  return out;
}

export type MonthlyRow = { month: string; profit: number } & Record<string, unknown>;
/** Add Bloom to the monthly P&L rows (dollars, like the rows): bloomGross, bloomCost, bloomNet, bloomToDate (a running month)
 *  and combined (= profit + bloomNet).
 *  A month with an invoice but no orders still gets a row. Rows keep their own fields; without invoices every row is unchanged
 *  apart from zeros. */
export function withBloomMonthly<T extends MonthlyRow>(monthly: T[], invoices: InvoiceMoney[], blank: (month: string) => T): (T & { bloomGross: number; bloomCost: number; bloomNet: number; bloomToDate: boolean; combined: number })[] {
  const by = new Map(invoices.map(i => [i.month, i]));
  const months = [...new Set([...monthly.map(m => m.month), ...by.keys()])].sort();
  const rowOf = new Map(monthly.map(m => [m.month, m]));
  return months.map(month => {
    const row = rowOf.get(month) ?? blank(month);
    const i = by.get(month);
    const gross = i ? (i.grossCents + i.otherIncomeCents) / 100 : 0;
    const cost = i ? (i.costsCents + i.feesCents) / 100 : 0;
    const net = i ? i.netCents / 100 : 0;
    return { ...row, bloomGross: gross, bloomCost: cost, bloomNet: net, bloomToDate: !!i?.toDate, combined: Math.round((row.profit + net) * 100) / 100 };
  });
}
