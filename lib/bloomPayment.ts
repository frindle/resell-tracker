// Bloom payment record: what Darkbloom still owes for each finished month, the payout requests (attempts) made by hand, and
// when the money arrived. RECORD ONLY: nothing here calls a Darkbloom write endpoint, starts a withdrawal or moves money.
//
// Paid comes from deposits: every posted Darkbloom-marked deposit, oldest first, is allocated FIFO to the invoices in month
// order, each up to its payout (gross less fees). Money that arrives before a month's invoice exists waits for it.
// Requests are attempts, several a month: each is "sent" (a deposit matches it), "pending", "flagged" (older than 7 days with
// no deposit) or "refunded" (the ledger saw the money come back). A refunded request never matches a deposit.
//
// Two invoice copies per month, both kept and never edited after they are written:
//   copy 1  written when the month's invoice is first stored, with what was due at that moment;
//   copy 2  written once the month's due reaches 0, with the deposits that covered it and the request each matched.
// Money is integer cents; days are 'YYYY-MM-DD' in Los Angeles time. Pure logic plus a store interface (lib/bloomPaymentService.ts
// wires it to Prisma), so the rules are tested without a database.
import { laDay } from './books/dates.ts';

/** A deposit counts as the payment for a request when it lands this many days after the request day (inclusive). */
export const MATCH_WINDOW_DAYS = 14;
/** An unmatched request is flagged once it is older than this many days. */
export const FLAG_AFTER_DAYS = 7;
/** Deposit vs request: within the larger of this many cents or 1%. */
export const MATCH_TOL_CENTS = 100;
export const MATCH_TOL_PCT = 1;

export type Deposit = { txnId: number; date: string; cents: number };
export type PaymentRequest = {
  id: number; source: 'detected' | 'manual'; ledgerKey: string | null;
  requestedAt: string; requestedCents: number; refundedAt: string | null;
  sentDate: string | null; sentCents: number | null; sentTxnId: number | null;
};
export type NewRequest = Pick<PaymentRequest, 'source' | 'ledgerKey' | 'requestedAt' | 'requestedCents' | 'refundedAt'>;
export type LedgerWithdrawal = { key: string; requestedAt: string; amountCents: number; status: 'requested' | 'refunded'; refundedAt: string | null };

export type MonthStatus = 'paid' | 'part_paid' | 'due' | 'nothing_due';
export type CoveringDeposit = { date: string; cents: number; requestedAt: string | null };
/** What a stored copy says about the month's payment. */
export type PaymentBlock = {
  payoutCents: number; allocatedCents: number; dueCents: number; status: MonthStatus;
  deposits: CoveringDeposit[]; sentDate: string | null;
};

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);

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

export type Allocation = { payoutCents: number; allocatedCents: number; dueCents: number; status: MonthStatus; covering: { txnId: number; date: string; cents: number }[] };

/** FIFO: deposits oldest first (then by id) fill the invoices in month order, each up to its payout. Deposits left over wait for
 *  an invoice that does not exist yet. due = payout - allocated; a payout of zero or less is "nothing due". */
export function allocate(invoices: { month: string; grossCents: number; feesCents: number | null }[], deposits: Deposit[]): Map<string, Allocation> {
  const queue = deposits.filter(d => d.cents > 0).sort((a, b) => a.date.localeCompare(b.date) || a.txnId - b.txnId).map(d => ({ ...d }));
  const out = new Map<string, Allocation>();
  let at = 0;
  for (const inv of [...invoices].sort((a, b) => a.month.localeCompare(b.month))) {
    const payout = payoutCents(inv);
    let need = Math.max(0, payout);
    const covering: Allocation['covering'] = [];
    while (need > 0 && at < queue.length) {
      const q = queue[at];
      const take = Math.min(q.cents, need);
      covering.push({ txnId: q.txnId, date: q.date, cents: take });
      q.cents -= take; need -= take;
      if (q.cents === 0) at++;
    }
    const allocated = Math.max(0, payout) - need;
    const status: MonthStatus = payout <= 0 ? 'nothing_due' : need === 0 ? 'paid' : allocated > 0 ? 'part_paid' : 'due';
    out.set(inv.month, { payoutCents: payout, allocatedCents: allocated, dueCents: need, status, covering });
  }
  return out;
}

const tolerance = (cents: number) => Math.max(MATCH_TOL_CENTS, Math.round((Math.abs(cents) * MATCH_TOL_PCT) / 100));

/** The deposit that is this request's payment: unused, landed from the request day to MATCH_WINDOW_DAYS later, amount within
 *  tolerance. The closest amount wins, then the earliest day. A refunded request matches nothing. */
export function matchDeposit(req: Pick<PaymentRequest, 'requestedAt' | 'requestedCents'> & { refundedAt?: string | null }, deposits: Deposit[], used: Set<number>): Deposit | null {
  if (req.refundedAt) return null;
  const day = requestDay(req.requestedAt);
  if (!day) return null;
  const last = addDays(day, MATCH_WINDOW_DAYS);
  const tol = tolerance(req.requestedCents);
  const fits = deposits.filter(d => !used.has(d.txnId) && d.date >= day && d.date <= last && Math.abs(d.cents - req.requestedCents) <= tol);
  fits.sort((a, b) => Math.abs(a.cents - req.requestedCents) - Math.abs(b.cents - req.requestedCents) || a.date.localeCompare(b.date) || a.txnId - b.txnId);
  return fits[0] ?? null;
}

export type RequestStatus = 'sent' | 'pending' | 'flagged' | 'refunded';
/** refunded wins; then sent (a deposit matched); flagged = older than FLAG_AFTER_DAYS with no deposit; otherwise pending. */
export function requestStatus(req: Pick<PaymentRequest, 'requestedAt' | 'sentDate' | 'refundedAt'>, today: string): RequestStatus {
  if (req.refundedAt) return 'refunded';
  if (req.sentDate) return 'sent';
  const day = requestDay(req.requestedAt);
  return day && daysBetween(day, today) > FLAG_AFTER_DAYS ? 'flagged' : 'pending';
}

/** Parse the ledger's /v1/withdrawals answer; malformed rows are dropped, never trusted. A missing or unknown status is "requested". */
export function parseWithdrawals(raw: unknown): LedgerWithdrawal[] {
  const list = rec(raw).withdrawals;
  if (!Array.isArray(list)) throw new Error('ledger answer has no withdrawals list');
  const out: LedgerWithdrawal[] = [];
  for (const w of list) {
    const x = rec(w);
    if (typeof x.key === 'string' && x.key && typeof x.requested_at === 'string' && requestDay(x.requested_at) && isInt(x.amount_cents) && x.amount_cents > 0) {
      const refunded = x.status === 'refunded';
      const at = typeof x.refunded_at === 'string' && requestDay(x.refunded_at) ? x.refunded_at : x.requested_at;
      out.push({ key: x.key.slice(0, 80), requestedAt: x.requested_at, amountCents: x.amount_cents, status: refunded ? 'refunded' : 'requested', refundedAt: refunded ? at : null });
    }
  }
  return out;
}

// ---- copies ----

export type CopyRow = { month: string; copy: 1 | 2; hash: string; dueCents: number; payload: string };
export type InvoiceRecord = { month: string; hash: string; grossCents: number; feesCents: number; payload: string };

/** The stored form of one copy: the invoice as it stood plus the payment block. Written once, never updated. */
export function copyPayload(invoicePayload: string, copy: 1 | 2, block: PaymentBlock): string {
  return JSON.stringify({ ...(JSON.parse(invoicePayload) as object), copy, finalCopy: copy === 2 || block.status === 'nothing_due', payment: block });
}

export interface PaymentStore {
  invoices(userId: number): Promise<InvoiceRecord[]>;
  copies(userId: number): Promise<{ month: string; copy: number; payload: string }[]>;
  /** Insert a copy; false (and no change) when that (month, copy) already exists. */
  addCopy(userId: number, row: CopyRow): Promise<boolean>;
  requests(userId: number): Promise<PaymentRequest[]>;
  addRequest(userId: number, r: NewRequest): Promise<PaymentRequest>;
  setRefunded(userId: number, id: number, refundedAt: string): Promise<void>;
  setSent(userId: number, id: number, sentDate: string, sentCents: number, txnId: number): Promise<void>;
  clearSent(userId: number, id: number): Promise<void>;
  /** Darkbloom-marked bank credits, posted (not pending). */
  deposits(userId: number): Promise<Deposit[]>;
}

export type PaymentRunResult = { copy1: number; copy2: number; requests: number; refunded: number; matched: number; errors: string[] };

/** Match every open request to a deposit; a refunded request that had a match lets it go. Returns how many matched. */
async function matchRequests(store: PaymentStore, userId: number, deposits: Deposit[], out: PaymentRunResult) {
  const reqs = await store.requests(userId);
  for (const r of reqs.filter(x => x.refundedAt && x.sentTxnId != null)) await store.clearSent(userId, r.id);
  const used = new Set(reqs.filter(r => !r.refundedAt && r.sentTxnId != null).map(r => r.sentTxnId as number));
  for (const r of reqs.filter(x => !x.refundedAt && !x.sentDate).sort((a, b) => a.requestedAt.localeCompare(b.requestedAt) || a.id - b.id)) {
    const hit = matchDeposit(r, deposits, used);
    if (!hit) continue;
    used.add(hit.txnId);
    await store.setSent(userId, r.id, hit.date, hit.cents, hit.txnId);
    out.matched++;
  }
}

/** Copy 1 for every stored invoice that has none (with the due right now); copy 2 for every month whose due is 0 and has none. */
async function writeCopies(store: PaymentStore, userId: number, deposits: Deposit[], out: PaymentRunResult) {
  const invoices = await store.invoices(userId);
  const alloc = allocate(invoices, deposits);
  const copies = await store.copies(userId);
  const reqs = await store.requests(userId);
  const byTxn = new Map(reqs.filter(r => !r.refundedAt && r.sentTxnId != null).map(r => [r.sentTxnId as number, r]));
  for (const inv of invoices) {
    const a = alloc.get(inv.month) as Allocation;
    const has = (n: number) => copies.some(c => c.month === inv.month && c.copy === n);
    const block = (): PaymentBlock => ({
      payoutCents: a.payoutCents, allocatedCents: a.allocatedCents, dueCents: a.dueCents, status: a.status,
      deposits: a.covering.map(c => ({ date: c.date, cents: c.cents, requestedAt: byTxn.get(c.txnId)?.requestedAt ?? null })),
      sentDate: a.covering.length ? a.covering[a.covering.length - 1].date : null,
    });
    if (!has(1)) {
      const b = { ...block(), deposits: [], sentDate: null } as PaymentBlock;   // copy 1 states the due, not who paid it
      if (await store.addCopy(userId, { month: inv.month, copy: 1, hash: inv.hash, dueCents: b.dueCents, payload: copyPayload(inv.payload, 1, b) })) out.copy1++;
    }
    if (a.status === 'paid' && !has(2)) {
      const b = block();
      if (await store.addCopy(userId, { month: inv.month, copy: 2, hash: inv.hash, dueCents: 0, payload: copyPayload(inv.payload, 2, b) })) out.copy2++;
    }
  }
}

/**
 * One pass, safe to repeat: store the requests the ledger reports (`withdrawals` null when the ledger could not be asked;
 * a request later reported refunded gets refundedAt), match open requests to deposits, then write copy 1 for new invoices
 * and copy 2 for months whose due reached 0.
 */
export async function runPayments(store: PaymentStore, userId: number, withdrawals: LedgerWithdrawal[] | null): Promise<PaymentRunResult> {
  const out: PaymentRunResult = { copy1: 0, copy2: 0, requests: 0, refunded: 0, matched: 0, errors: [] };
  if (withdrawals) {
    const byKey = new Map((await store.requests(userId)).filter(r => r.ledgerKey).map(r => [r.ledgerKey as string, r]));
    for (const w of [...withdrawals].sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))) {
      const have = byKey.get(w.key);
      if (!have) {
        await store.addRequest(userId, { source: 'detected', ledgerKey: w.key, requestedAt: w.requestedAt, requestedCents: w.amountCents, refundedAt: w.refundedAt });
        out.requests++; if (w.refundedAt) out.refunded++;
      } else if (w.status === 'refunded' && !have.refundedAt) {
        await store.setRefunded(userId, have.id, w.refundedAt ?? w.requestedAt);
        out.refunded++;
      }
    }
  }
  const deposits = await store.deposits(userId);
  await matchRequests(store, userId, deposits, out);
  await writeCopies(store, userId, deposits, out);
  return out;
}

export type ManualInput = { requestedAt: string; requestedCents: number };
/** A hand-entered request (for when the snapshots missed it). Returns the new request or why it was refused. */
export async function addManualRequest(store: PaymentStore, userId: number, input: ManualInput): Promise<{ ok: PaymentRequest } | { error: string; status: number }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.requestedAt) || Number.isNaN(Date.parse(input.requestedAt))) return { error: 'requestedAt must be YYYY-MM-DD', status: 400 };
  if (!isInt(input.requestedCents) || input.requestedCents <= 0) return { error: 'requestedCents must be a positive whole number of cents', status: 400 };
  const r = await store.addRequest(userId, { source: 'manual', ledgerKey: null, requestedAt: input.requestedAt, requestedCents: input.requestedCents, refundedAt: null });
  const res: PaymentRunResult = { copy1: 0, copy2: 0, requests: 1, refunded: 0, matched: 0, errors: [] };
  const deposits = await store.deposits(userId);
  await matchRequests(store, userId, deposits, res);
  await writeCopies(store, userId, deposits, res);
  return { ok: r };
}

// ---- the read-only view ----

export type MonthRow = {
  month: string; invoiceId: string; payoutCents: number; allocatedCents: number; dueCents: number; status: MonthStatus;
  sentDate: string | null; copies: { copy: number; final: boolean }[];
};
export type RequestRow = { requestedAt: string; cents: number; source: string; status: RequestStatus; sentDate: string | null; refundedAt: string | null };

/** Per invoice month (newest first): payout, allocated, due, status and the copies; plus every request, newest first. */
export function paymentView(
  invoices: InvoiceRecord[], deposits: Deposit[], copies: { month: string; copy: number; payload: string }[], requests: PaymentRequest[], today: string,
): { months: MonthRow[]; requests: RequestRow[] } {
  const alloc = allocate(invoices, deposits);
  const months = [...invoices].sort((a, b) => b.month.localeCompare(a.month)).map(inv => {
    const a = alloc.get(inv.month) as Allocation;
    const mine = copies.filter(c => c.month === inv.month).sort((x, y) => x.copy - y.copy);
    let invoiceId = `BL-${inv.month}`;
    try { invoiceId = (JSON.parse(inv.payload) as { invoiceId?: string }).invoiceId ?? invoiceId; } catch { /* keep the default */ }
    return {
      month: inv.month, invoiceId, payoutCents: a.payoutCents, allocatedCents: a.allocatedCents, dueCents: a.dueCents, status: a.status,
      sentDate: a.covering.length ? a.covering[a.covering.length - 1].date : null,
      copies: mine.map(c => ({ copy: c.copy, final: c.copy === 2 || a.status === 'nothing_due' })),
    };
  });
  const reqs = [...requests].sort((a, b) => b.requestedAt.localeCompare(a.requestedAt) || b.id - a.id).map(r => ({
    requestedAt: r.requestedAt, cents: r.requestedCents, source: r.source, status: requestStatus(r, today), sentDate: r.sentDate, refundedAt: r.refundedAt,
  }));
  return { months, requests: reqs };
}
