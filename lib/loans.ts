/**
 * Loan math. Pure (no database), integer cents throughout.
 *
 * A loan's interest and fees are a cost that comes off reselling profit on the
 * date they post. Principal borrowed is not income and repaying it is not a
 * cost, so only interest + fees are ever summed into profit.
 *
 * Installment loans have no stored schedule: it is derived from the loan terms
 * plus the entries the user recorded (payment overrides, extra payments, fees).
 * "A scheduled payment counts as made unless you change it."
 */

export type LoanKind = 'installment' | 'line' | 'card';

export type LoanEntryLite = {
  id?: number;
  kind: string; // "payment" | "statement" | "fee" | "extra_payment"
  postedAt: Date;
  interestCents: number;
  feeCents: number;
  principalCents: number;
  balanceCents: number | null;
  periodIndex: number | null;
};

export type LoanLite = {
  id?: number;
  kind: string;
  principalCents: number;
  aprPercent: number | null;
  termMonths: number | null;
  startDate: Date | null;
  firstPaymentDate: Date | null;
  originationFeeCents: number;
  entries: LoanEntryLite[];
};

export type ScheduleRow = {
  /** 1-based payment number; null for an extra payment row. */
  index: number | null;
  type: 'payment' | 'extra';
  date: Date;
  paymentCents: number; // interest + principal actually paid
  interestCents: number;
  principalCents: number;
  feeCents: number;
  balanceCents: number; // balance after this row
  /** true when the user's recorded numbers replaced the computed ones */
  recorded: boolean;
  /** LoanEntry id behind a recorded row (to delete / reset it) */
  entryId?: number;
};

export type Posting = { date: Date; interestCents: number; feeCents: number };

/** Dollars (number or numeric string) to integer cents; null when not a finite number. */
export function toCents(v: unknown): number | null {
  if (v === '' || v == null) return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100 + (n < 0 ? -1e-9 : 1e-9));
}

/** "YYYY-MM-DD" to a local-noon Date (noon keeps DST shifts from changing the day). */
export function parseDay(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Same day-of-month `k` months on, clamped to the month's last day. */
export function addMonths(d: Date, k: number, day = d.getDate()): Date {
  const first = new Date(d.getFullYear(), d.getMonth() + k, 1, 12);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  return new Date(first.getFullYear(), first.getMonth(), Math.min(day, last), 12);
}

function daysBetween(a: Date, b: Date): number {
  const ua = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const ub = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((ub - ua) / 86400000);
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Standard fixed monthly payment, rounded to the cent. */
export function monthlyPaymentCents(principalCents: number, aprPercent: number, months: number): number {
  if (months <= 0) return principalCents;
  const r = aprPercent / 1200;
  if (r === 0) return Math.round(principalCents / months);
  return Math.round((principalCents * r) / (1 - Math.pow(1 + r, -months)));
}

/** Funding date: explicit, else one month before the first payment. */
export function fundedOn(loan: Pick<LoanLite, 'startDate' | 'firstPaymentDate'>): Date | null {
  if (loan.startDate) return loan.startDate;
  if (loan.firstPaymentDate) return addMonths(loan.firstPaymentDate, -1);
  return null;
}

/**
 * The payment schedule of an installment loan.
 *
 * - Interest per regular period is balance * APR / 12 rounded to the cent. A
 *   first period that is not exactly one month (funded late in the month, say)
 *   uses actual days / 365 instead -- the "short first month".
 * - The payment is fixed; the final payment pays off whatever is left, so it
 *   absorbs rounding.
 * - An extra payment dated before a scheduled payment is applied to the balance
 *   before that payment's interest, so it shortens the schedule.
 * - A "payment" entry with periodIndex N replaces row N's date, interest,
 *   principal and fee with what the user entered; later rows continue from the
 *   resulting balance.
 */
export function buildSchedule(loan: LoanLite): ScheduleRow[] {
  if (loan.kind !== 'installment' || !loan.termMonths || !loan.firstPaymentDate || loan.principalCents <= 0) return [];
  const apr = loan.aprPercent ?? 0;
  const n = loan.termMonths;
  const first = loan.firstPaymentDate;
  const funded = fundedOn(loan)!;
  const payment = monthlyPaymentCents(loan.principalCents, apr, n);

  const extras = loan.entries
    .filter(e => e.kind === 'extra_payment')
    .sort((a, b) => a.postedAt.getTime() - b.postedAt.getTime());
  const overrides = new Map<number, LoanEntryLite>();
  for (const e of loan.entries) if (e.kind === 'payment' && e.periodIndex != null) overrides.set(e.periodIndex, e);

  const rows: ScheduleRow[] = [];
  let balance = loan.principalCents;
  let nextExtra = 0;
  // Safety cap: a run of recorded $0 payments could otherwise extend forever.
  for (let i = 1; balance > 0 && i <= n + 120; i++) {
    const due = addMonths(first, i - 1, first.getDate());
    while (nextExtra < extras.length && extras[nextExtra].postedAt.getTime() < due.getTime() && balance > 0) {
      balance = pushExtra(rows, extras[nextExtra++], balance);
    }
    if (balance <= 0) break;

    const monthRate = apr / 1200;
    let interest: number;
    if (i === 1 && !sameDay(addMonths(due, -1), funded)) {
      interest = Math.round((balance * apr / 100 * Math.max(daysBetween(funded, due), 0)) / 365);
    } else {
      interest = Math.round(balance * monthRate);
    }

    const ov = overrides.get(i);
    if (ov) {
      const principal = Math.min(Math.max(ov.principalCents, 0), balance);
      balance -= principal;
      rows.push({
        index: i, type: 'payment', date: ov.postedAt,
        paymentCents: ov.interestCents + principal, interestCents: ov.interestCents, principalCents: principal,
        feeCents: ov.feeCents, balanceCents: balance, recorded: true, entryId: ov.id,
      });
      continue;
    }
    let principal = payment - interest;
    if (i >= n || principal >= balance || principal < 0) principal = i >= n || principal >= balance ? balance : 0;
    balance -= principal;
    rows.push({
      index: i, type: 'payment', date: due,
      paymentCents: interest + principal, interestCents: interest, principalCents: principal,
      feeCents: 0, balanceCents: balance, recorded: false,
    });
  }
  // Extra payments dated after the last scheduled row (or after the loan was
  // already paid off) still count: they reduce whatever balance is left and
  // their recorded interest/fee still post.
  while (nextExtra < extras.length) balance = pushExtra(rows, extras[nextExtra++], balance);
  return rows;
}

function pushExtra(rows: ScheduleRow[], e: LoanEntryLite, balance: number): number {
  const paid = Math.min(Math.max(e.principalCents, 0), balance);
  const left = balance - paid;
  rows.push({
    index: null, type: 'extra', date: e.postedAt,
    paymentCents: paid + e.interestCents, interestCents: e.interestCents, principalCents: paid,
    feeCents: e.feeCents, balanceCents: left, recorded: true, entryId: e.id,
  });
  return left;
}

/** Every dated interest/fee cost a loan has posted (or will post). */
export function loanPostings(loan: LoanLite): Posting[] {
  const out: Posting[] = [];
  if (loan.kind === 'installment') {
    const funded = fundedOn(loan);
    if (funded && loan.originationFeeCents > 0) out.push({ date: funded, interestCents: 0, feeCents: loan.originationFeeCents });
    for (const r of buildSchedule(loan)) {
      if (r.interestCents || r.feeCents) out.push({ date: r.date, interestCents: r.interestCents, feeCents: r.feeCents });
    }
    // Stand-alone fees (a late fee). Payment/extra entries are already in the schedule rows.
    for (const e of loan.entries) {
      if (e.kind === 'fee' && (e.interestCents || e.feeCents)) out.push({ date: e.postedAt, interestCents: e.interestCents, feeCents: e.feeCents });
    }
  } else {
    for (const e of loan.entries) {
      if (e.interestCents || e.feeCents) out.push({ date: e.postedAt, interestCents: e.interestCents, feeCents: e.feeCents });
    }
  }
  return out;
}

function inWindow(p: Posting, start: Date | null, end: Date, asOf: Date): boolean {
  const t = p.date.getTime();
  return t <= asOf.getTime() && t <= end.getTime() && (start === null || t >= start.getTime());
}

/**
 * Interest + fees that posted in [start, end], capped at `asOf` so scheduled
 * payments still in the future never count. This is the one number the home
 * page and Analytics both subtract from a period's order profit.
 */
export function sumLoanCostCents(loans: LoanLite[], start: Date | null, end: Date, asOf: Date = new Date()): { interestCents: number; feeCents: number; totalCents: number } {
  let interestCents = 0;
  let feeCents = 0;
  for (const loan of loans) {
    for (const p of loanPostings(loan)) {
      if (!inWindow(p, start, end, asOf)) continue;
      interestCents += p.interestCents;
      feeCents += p.feeCents;
    }
  }
  return { interestCents, feeCents, totalCents: interestCents + feeCents };
}

/** Same cost bucketed by "YYYY-MM" for the Analytics monthly table. */
export function loanCostByMonth(loans: LoanLite[], start: Date, end: Date, asOf: Date = new Date()): Record<string, number> {
  const out: Record<string, number> = {};
  for (const loan of loans) {
    for (const p of loanPostings(loan)) {
      if (!inWindow(p, start, end, asOf)) continue;
      const key = `${p.date.getFullYear()}-${String(p.date.getMonth() + 1).padStart(2, '0')}`;
      out[key] = (out[key] ?? 0) + p.interestCents + p.feeCents;
    }
  }
  return out;
}

export type LoanSummary = {
  balanceCents: number | null;
  interestYtdCents: number;
  interestAllTimeCents: number;
  feesYtdCents: number;
  feesAllTimeCents: number;
  payoffDate: Date | null;
  schedule: ScheduleRow[];
};

export function summarizeLoan(loan: LoanLite, now: Date = new Date()): LoanSummary {
  const ytdStart = new Date(now.getFullYear(), 0, 1);
  const ytd = sumLoanCostCents([loan], ytdStart, now, now);
  const all = sumLoanCostCents([loan], null, now, now);
  const schedule = buildSchedule(loan);
  let balanceCents: number | null;
  let payoffDate: Date | null = null;
  if (loan.kind === 'installment') {
    balanceCents = loan.principalCents;
    for (const r of schedule) if (r.date.getTime() <= now.getTime()) balanceCents = r.balanceCents;
    const closing = schedule.find(r => r.balanceCents === 0);
    if (closing) payoffDate = closing.date;
  } else {
    const stmts = loan.entries
      .filter(e => e.kind === 'statement' && e.balanceCents != null && e.postedAt.getTime() <= now.getTime())
      .sort((a, b) => a.postedAt.getTime() - b.postedAt.getTime());
    balanceCents = stmts.length ? stmts[stmts.length - 1].balanceCents : null;
  }
  return {
    balanceCents,
    interestYtdCents: ytd.interestCents,
    interestAllTimeCents: all.interestCents,
    feesYtdCents: ytd.feeCents,
    feesAllTimeCents: all.feeCents,
    payoffDate,
    schedule,
  };
}

// ---- request parsing (shared by the API routes) ----

const KINDS = ['installment', 'line', 'card'];
const ENTRY_KINDS = ['payment', 'statement', 'fee', 'extra_payment'];

export type LoanInput = {
  kind: string; name: string; cardId: number | null;
  principalCents: number; aprPercent: number | null; termMonths: number | null;
  startDate: Date | null; firstPaymentDate: Date | null; originationFeeCents: number;
};

/** Validate a loan request body (money in dollars). Returns an error string or the parsed loan. */
export function parseLoanBody(b: Record<string, unknown>): { error: string } | { ok: LoanInput } {
  const kind = String(b.kind ?? '');
  if (!KINDS.includes(kind)) return { error: 'kind must be installment, line or card' };
  const name = String(b.name ?? '').trim();
  if (!name) return { error: 'name is required' };
  const cardId = kind === 'card' && b.cardId != null && b.cardId !== '' ? Number(b.cardId) : null;
  if (cardId !== null && !Number.isInteger(cardId)) return { error: 'invalid cardId' };
  const base: LoanInput = {
    kind, name, cardId, principalCents: 0, aprPercent: null, termMonths: null,
    startDate: null, firstPaymentDate: null, originationFeeCents: 0,
  };
  if (kind !== 'installment') return { ok: base };
  const principal = toCents(b.amount);
  if (principal == null || principal <= 0) return { error: 'amount must be greater than 0' };
  const apr = b.aprPercent === '' || b.aprPercent == null ? 0 : Number(b.aprPercent);
  if (!Number.isFinite(apr) || apr < 0 || apr > 200) return { error: 'invalid APR' };
  const term = Number(b.termMonths);
  if (!Number.isInteger(term) || term < 1 || term > 600) return { error: 'months must be a whole number from 1 to 600' };
  const first = parseDay(b.firstPaymentDate);
  if (!first) return { error: 'first payment date is required' };
  const start = b.startDate ? parseDay(b.startDate) : null;
  if (b.startDate && !start) return { error: 'invalid start date' };
  const fee = b.originationFee === '' || b.originationFee == null ? 0 : toCents(b.originationFee);
  if (fee == null || fee < 0) return { error: 'invalid fee' };
  return { ok: { ...base, principalCents: principal, aprPercent: apr, termMonths: term, startDate: start, firstPaymentDate: first, originationFeeCents: fee } };
}

export type EntryInput = {
  kind: string; postedAt: Date; interestCents: number; feeCents: number; principalCents: number;
  balanceCents: number | null; periodIndex: number | null; note: string | null;
};

export function parseEntryBody(b: Record<string, unknown>, loanKind: string): { error: string } | { ok: EntryInput } {
  const kind = String(b.kind ?? '');
  if (!ENTRY_KINDS.includes(kind)) return { error: 'invalid entry kind' };
  if (loanKind === 'installment' && kind === 'statement') return { error: 'installment loans have payments, not statements' };
  if (loanKind !== 'installment' && (kind === 'payment' || kind === 'extra_payment')) return { error: 'lines and cards use statements' };
  const postedAt = parseDay(b.postedAt);
  if (!postedAt) return { error: 'date is required' };
  const money = (v: unknown) => (v === '' || v == null ? 0 : toCents(v));
  const interest = money(b.interest), fee = money(b.fee), principal = money(b.principal);
  if (interest == null || fee == null || principal == null || interest < 0 || fee < 0 || principal < 0) return { error: 'amounts must be zero or more' };
  const balance = b.balance === '' || b.balance == null ? null : toCents(b.balance);
  if (b.balance !== '' && b.balance != null && (balance == null || balance < 0)) return { error: 'invalid balance' };
  const periodIndex = kind === 'payment' ? Number(b.periodIndex) : null;
  if (kind === 'payment' && (!Number.isInteger(periodIndex) || (periodIndex as number) < 1)) return { error: 'payment needs a schedule row number' };
  const note = typeof b.note === 'string' && b.note.trim() ? b.note.trim() : null;
  return { ok: { kind, postedAt, interestCents: interest, feeCents: fee, principalCents: principal, balanceCents: kind === 'statement' ? balance : null, periodIndex, note } };
}

// ---- partial updates (PATCH): merge onto the stored row, then validate like create ----

const dollars = (c: number | null | undefined) => (c == null ? '' : (c / 100).toFixed(2));
const dayStr = (d: Date | null | undefined) =>
  d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : '';

/** Stored loan as a create-style body (dollars, "YYYY-MM-DD"), overlaid with the patch. */
export function mergeLoanPatch(existing: LoanInput & { cardId: number | null }, patch: Record<string, unknown>): Record<string, unknown> {
  const base: Record<string, unknown> = {
    kind: existing.kind, name: existing.name, cardId: existing.cardId,
    amount: dollars(existing.principalCents), aprPercent: existing.aprPercent ?? '',
    termMonths: existing.termMonths ?? '', startDate: dayStr(existing.startDate),
    firstPaymentDate: dayStr(existing.firstPaymentDate), originationFee: dollars(existing.originationFeeCents),
  };
  const out = { ...base };
  for (const k of Object.keys(base)) if (k in patch) out[k] = patch[k];
  // The kind of a loan cannot change: entries are typed to it.
  out.kind = existing.kind;
  return out;
}

/** Stored entry as a create-style body, overlaid with the patch. Kind and schedule row are fixed. */
export function mergeEntryPatch(existing: EntryInput, patch: Record<string, unknown>): Record<string, unknown> {
  const base: Record<string, unknown> = {
    postedAt: dayStr(existing.postedAt), interest: dollars(existing.interestCents), fee: dollars(existing.feeCents),
    principal: dollars(existing.principalCents), balance: dollars(existing.balanceCents), note: existing.note ?? '',
  };
  const out = { ...base };
  for (const k of Object.keys(base)) if (k in patch) out[k] = patch[k];
  out.kind = existing.kind;
  out.periodIndex = existing.periodIndex;
  return out;
}
