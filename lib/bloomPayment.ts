// Bloom payment record: for each finished month, what Darkbloom still owed once the invoice was final, when the payout
// was requested, and when the money arrived. RECORD ONLY: nothing here calls a Darkbloom write endpoint, starts a
// withdrawal or moves money. The request is found by the ledger (GET /v1/withdrawals, from its balance snapshots) or
// typed in by hand; the arrival is the Darkbloom-marked bank deposit that matches it.
//
// Two invoice copies per month, both kept and never edited after they are written:
//   copy 1  written when the month's invoice is first stored (final), with what was due then;
//   copy 2  written once the payment is matched, with the requested and sent dates. It is the final one.
// Money is integer cents; days are 'YYYY-MM-DD' in Los Angeles time. Pure logic plus a store interface (lib/bloomPaymentService.ts
// wires it to Prisma), so the rules are tested without a database.
import { laDay, MONTH_RE, nextMonth } from './books/dates.ts';

/** A deposit counts as the payment for a request when it lands this many days after the request day (inclusive). */
export const MATCH_WINDOW_DAYS = 14;
/** An unmatched request is flagged once it is older than this many days. */
export const FLAG_AFTER_DAYS = 7;
/** Deposit vs request: within the larger of this many cents or 1%. */
export const MATCH_TOL_CENTS = 100;
export const MATCH_TOL_PCT = 1;

export type Deposit = { txnId: number; date: string; cents: number };
export type PaymentRequest = {
  id: number; month: string; source: 'detected' | 'manual'; ledgerKey: string | null;
  requestedAt: string; requestedCents: number;
  sentDate: string | null; sentCents: number | null; sentTxnId: number | null;
};
export type NewRequest = Omit<PaymentRequest, 'id' | 'sentDate' | 'sentCents' | 'sentTxnId'>;
export type LedgerWithdrawal = { key: string; requestedAt: string; amountCents: number };

export type PaymentBlock = {
  payoutCents: number; depositsCents: number; dueCents: number; nothingDue: boolean;
  requested: { at: string; day: string; cents: number; source: string } | null;
  sent: { date: string; cents: number } | null;
};

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
export const prevMonth = (month: string): string => {
  const y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7));
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};

/** The Los Angeles day of a request time: a plain 'YYYY-MM-DD' stays as it is, an ISO instant is converted. */
export function requestDay(at: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(at)) return at;
  const t = Date.parse(at);
  return Number.isNaN(t) ? null : laDay(new Date(t));
}

/** What Darkbloom paid out for the month: gross less its fee (the other-income and cost lines are not Darkbloom pay). */
export function payoutCents(inv: { grossCents: number; feesCents: number | null }): number {
  return inv.grossCents - (inv.feesCents ?? 0);
}

/** Due for month M: the invoice payout minus the Darkbloom-marked deposits that landed in M. Zero or less is "nothing due". */
export function amountDue(inv: { month: string; grossCents: number; feesCents: number | null }, deposits: Deposit[]): Pick<PaymentBlock, 'payoutCents' | 'depositsCents' | 'dueCents' | 'nothingDue'> {
  const payout = payoutCents(inv);
  const dep = deposits.filter(d => d.date.slice(0, 7) === inv.month).reduce((s, d) => s + d.cents, 0);
  const left = payout - dep;
  return { payoutCents: payout, depositsCents: dep, dueCents: Math.max(0, left), nothingDue: left <= 0 };
}

/** The invoice month a request belongs to: the month before the day it was made (the invoice that had just become final). */
export function monthOfRequest(at: string): string | null {
  const day = requestDay(at);
  return day ? prevMonth(day.slice(0, 7)) : null;
}

const tolerance = (cents: number) => Math.max(MATCH_TOL_CENTS, Math.round((Math.abs(cents) * MATCH_TOL_PCT) / 100));

/** The deposit that is this request's payment: unused, landed from the request day to MATCH_WINDOW_DAYS later, amount within
 *  tolerance. The closest amount wins, then the earliest day. */
export function matchDeposit(req: Pick<PaymentRequest, 'requestedAt' | 'requestedCents'>, deposits: Deposit[], used: Set<number>): Deposit | null {
  const day = requestDay(req.requestedAt);
  if (!day) return null;
  const last = addDays(day, MATCH_WINDOW_DAYS);
  const tol = tolerance(req.requestedCents);
  const fits = deposits.filter(d => !used.has(d.txnId) && d.date >= day && d.date <= last && Math.abs(d.cents - req.requestedCents) <= tol);
  fits.sort((a, b) => Math.abs(a.cents - req.requestedCents) - Math.abs(b.cents - req.requestedCents) || a.date.localeCompare(b.date) || a.txnId - b.txnId);
  return fits[0] ?? null;
}

export type PaymentStatus = 'nothing_due' | 'not_requested' | 'requested' | 'sent' | 'unmatched';
/** unmatched = requested more than FLAG_AFTER_DAYS ago and no matching deposit yet (shown as a flag on the page). */
export function paymentStatus(block: Pick<PaymentBlock, 'nothingDue'>, req: PaymentRequest | null, today: string): PaymentStatus {
  if (req) {
    if (req.sentDate) return 'sent';
    const day = requestDay(req.requestedAt);
    return day && daysBetween(day, today) > FLAG_AFTER_DAYS ? 'unmatched' : 'requested';
  }
  return block.nothingDue ? 'nothing_due' : 'not_requested';
}

/** Parse the ledger's /v1/withdrawals answer; malformed rows are dropped, never trusted. */
export function parseWithdrawals(raw: unknown): LedgerWithdrawal[] {
  const list = rec(raw).withdrawals;
  if (!Array.isArray(list)) throw new Error('ledger answer has no withdrawals list');
  const out: LedgerWithdrawal[] = [];
  for (const w of list) {
    const x = rec(w);
    if (typeof x.key === 'string' && x.key && typeof x.requested_at === 'string' && requestDay(x.requested_at) && isInt(x.amount_cents) && x.amount_cents > 0) {
      out.push({ key: x.key.slice(0, 80), requestedAt: x.requested_at, amountCents: x.amount_cents });
    }
  }
  return out;
}

// ---- copies ----

export type CopyRow = { month: string; copy: 1 | 2; hash: string; dueCents: number; payload: string };
export type InvoiceRecord = { month: string; hash: string; grossCents: number; feesCents: number; payload: string };

/** The stored form of one copy: the invoice as it stood plus the payment block. Written once, never updated. */
export function copyPayload(invoicePayload: string, copy: 1 | 2, block: PaymentBlock): string {
  return JSON.stringify({ ...(JSON.parse(invoicePayload) as object), copy, finalCopy: copy === 2 || block.nothingDue, payment: block });
}

export interface PaymentStore {
  invoices(userId: number): Promise<InvoiceRecord[]>;
  copies(userId: number): Promise<{ month: string; copy: number; payload: string }[]>;
  /** Insert a copy; false (and no change) when that (month, copy) already exists. */
  addCopy(userId: number, row: CopyRow): Promise<boolean>;
  requests(userId: number): Promise<PaymentRequest[]>;
  addRequest(userId: number, r: NewRequest): Promise<PaymentRequest>;
  setSent(userId: number, id: number, sentDate: string, sentCents: number, txnId: number): Promise<void>;
  /** Darkbloom-marked bank credits, posted (not pending). */
  deposits(userId: number): Promise<Deposit[]>;
}

export type PaymentRunResult = { copy1: number; copy2: number; requests: number; matched: number; errors: string[] };

async function matchAndFinish(store: PaymentStore, userId: number, deposits: Deposit[], out: PaymentRunResult) {
  const invoices = new Map((await store.invoices(userId)).map(i => [i.month, i]));
  const reqs = await store.requests(userId);
  const used = new Set(reqs.filter(r => r.sentTxnId != null).map(r => r.sentTxnId as number));
  for (const r of reqs.filter(x => !x.sentDate).sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))) {
    const inv = invoices.get(r.month);
    const hit = inv ? matchDeposit(r, deposits, used) : null;
    if (!inv || !hit) continue;
    used.add(hit.txnId);
    await store.setSent(userId, r.id, hit.date, hit.cents, hit.txnId);
    out.matched++;
    const block: PaymentBlock = {
      ...amountDue(inv, deposits),
      requested: { at: r.requestedAt, day: requestDay(r.requestedAt) ?? '', cents: r.requestedCents, source: r.source },
      sent: { date: hit.date, cents: hit.cents },
    };
    if (await store.addCopy(userId, { month: r.month, copy: 2, hash: inv.hash, dueCents: block.dueCents, payload: copyPayload(inv.payload, 2, block) })) out.copy2++;
  }
}

/**
 * One pass, safe to repeat: write copy 1 for every stored invoice that has none, record new requests the ledger reports
 * (`withdrawals` null when the ledger could not be asked), then match unsent requests to deposits and write copy 2.
 * A request belongs to the month before the day it was made, only when that month has an invoice with something due
 * and no request yet; any other request is ignored.
 */
export async function runPayments(store: PaymentStore, userId: number, withdrawals: LedgerWithdrawal[] | null): Promise<PaymentRunResult> {
  const out: PaymentRunResult = { copy1: 0, copy2: 0, requests: 0, matched: 0, errors: [] };
  const deposits = await store.deposits(userId);
  const invoices = await store.invoices(userId);
  const have = new Set((await store.copies(userId)).filter(c => c.copy === 1).map(c => c.month));
  for (const inv of invoices) {
    if (have.has(inv.month)) continue;
    const block: PaymentBlock = { ...amountDue(inv, deposits), requested: null, sent: null };
    if (await store.addCopy(userId, { month: inv.month, copy: 1, hash: inv.hash, dueCents: block.dueCents, payload: copyPayload(inv.payload, 1, block) })) out.copy1++;
  }
  if (withdrawals) {
    const reqs = await store.requests(userId);
    const seen = new Set(reqs.map(r => r.ledgerKey).filter((k): k is string => !!k));
    const taken = new Set(reqs.map(r => r.month));
    const byMonth = new Map(invoices.map(i => [i.month, i]));
    for (const w of [...withdrawals].sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))) {
      if (seen.has(w.key)) continue;
      const month = monthOfRequest(w.requestedAt);
      const inv = month ? byMonth.get(month) : undefined;
      if (!month || !inv || taken.has(month) || amountDue(inv, deposits).nothingDue) continue;
      await store.addRequest(userId, { month, source: 'detected', ledgerKey: w.key, requestedAt: w.requestedAt, requestedCents: w.amountCents });
      taken.add(month); seen.add(w.key); out.requests++;
    }
  }
  await matchAndFinish(store, userId, deposits, out);
  return out;
}

export type ManualInput = { month: string; requestedAt: string; requestedCents: number };
/** A hand-entered request (for when the snapshots missed it). Returns the new request or why it was refused. */
export async function addManualRequest(store: PaymentStore, userId: number, input: ManualInput): Promise<{ ok: PaymentRequest } | { error: string; status: number }> {
  if (!MONTH_RE.test(input.month)) return { error: 'bad month', status: 400 };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.requestedAt) || Number.isNaN(Date.parse(input.requestedAt))) return { error: 'requestedAt must be YYYY-MM-DD', status: 400 };
  if (!isInt(input.requestedCents) || input.requestedCents <= 0) return { error: 'requestedCents must be a positive whole number of cents', status: 400 };
  if (input.requestedAt < `${nextMonth(input.month)}-01`) return { error: 'a request is made after the month ends', status: 400 };
  const inv = (await store.invoices(userId)).find(i => i.month === input.month);
  if (!inv) return { error: 'no invoice for that month yet', status: 404 };
  if ((await store.requests(userId)).some(r => r.month === input.month)) return { error: 'that month already has a request', status: 409 };
  const r = await store.addRequest(userId, { month: input.month, source: 'manual', ledgerKey: null, requestedAt: input.requestedAt, requestedCents: input.requestedCents });
  const res: PaymentRunResult = { copy1: 0, copy2: 0, requests: 1, matched: 0, errors: [] };
  await matchAndFinish(store, userId, await store.deposits(userId), res);
  return { ok: r };
}

// ---- the read-only view ----

export type PaymentRow = {
  month: string; invoiceId: string; status: PaymentStatus; flagged: boolean;
  payoutCents: number; depositsCents: number; dueCents: number; nothingDue: boolean;
  requested: { at: string; cents: number; source: string } | null; sent: { date: string; cents: number } | null;
  copies: { copy: number; final: boolean }[];
};

/** One row per month with an invoice, newest first, from the stored copy 1 (what was due when the invoice was final), the
 *  request and the copies. Months whose copy 1 is not written yet are left out. */
export function paymentRows(copies: { month: string; copy: number; payload: string }[], requests: PaymentRequest[], today: string): PaymentRow[] {
  const months = [...new Set(copies.map(c => c.month))].sort().reverse();
  return months.flatMap(month => {
    const c1 = copies.find(c => c.month === month && c.copy === 1);
    if (!c1) return [];
    const p = JSON.parse(c1.payload) as { invoiceId?: string; payment: PaymentBlock };
    const req = requests.find(r => r.month === month) ?? null;
    const status = paymentStatus(p.payment, req, today);
    return [{
      month, invoiceId: p.invoiceId ?? `BL-${month}`, status, flagged: status === 'unmatched',
      payoutCents: p.payment.payoutCents, depositsCents: p.payment.depositsCents, dueCents: p.payment.dueCents, nothingDue: p.payment.nothingDue,
      requested: req ? { at: req.requestedAt, cents: req.requestedCents, source: req.source } : null,
      sent: req?.sentDate ? { date: req.sentDate, cents: req.sentCents ?? 0 } : null,
      copies: copies.filter(c => c.month === month).sort((a, b) => a.copy - b.copy).map(c => ({ copy: c.copy, final: c.copy === 2 || p.payment.nothingDue })),
    }];
  });
}
