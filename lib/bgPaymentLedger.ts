// Exact BuyingGroup payment -> receipts mapping. Pure (no imports), unit tested.
//
// BG auto-requests a payment whenever there is an unrequested balance, and each request sweeps the whole of it. So a payment is
// exactly the receipt credits (the Activity page's "Receipt" rows) booked after the previous payment was requested, up to its own
// request time. A receipt's activity amount is its total plus the 5 cent tracking reward. Nothing here guesses: a payment whose
// credits do not add up to the cent, and have no single exact subset either, is left unassigned and reported.

import { attributeReceipts, type AttributionOrder } from './bgReceiptAttribution.ts';

export type BGActivity = {
  type?: string;
  reference_id?: string;
  amount?: string | number;
  balance?: string | number;
  credit?: string | number;
  details?: string;
  created_dt?: string;
  [key: string]: unknown;
};

/** A receipt credit on the activity feed: receipt id (as BG names it), cents (receipt total + 5 cents), and when it was credited (ms). */
export type ReceiptCredit = { receiptId: string; cents: number; at: number };
/** A payment as BG lists it: id, cents, and when it was requested (ms). */
export type LedgerPaymentIn = { id: string; cents: number; at: number };

export type PaymentLedger = {
  /** payment id -> the receipt ids it covers (exact). */
  byPayment: Map<string, string[]>;
  /** Payments with no exact answer, with the receipts credited in their request window (a conservative stand-in, not an answer). */
  unassignedPayments: { id: string; cents: number; windowReceipts: string[] }[];
  /** Receipt credits no payment covers. */
  unassignedReceipts: string[];
  /** Unassigned receipt credits booked after the last payment was requested: the unrequested balance. */
  afterLastPayment: string[];
};

/** "R-123" and "123" name the same receipt. */
export function bgRefKey(id: unknown): string {
  return String(id ?? '').trim().replace(/^[A-Za-z]-/, '');
}

/** BG timestamp ("MM-DD-YYYY HH:MM:SS", "MM/DD/YYYY ...", or ISO) as ms; null when unreadable. Read as UTC when no zone is given, consistently for every row. */
export function bgTime(v: unknown): number | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const us = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (us) return Date.UTC(+us[3], +us[1] - 1, +us[2], +(us[4] ?? 0), +(us[5] ?? 0), +(us[6] ?? 0));
  const iso = /^\d{4}-\d{2}-\d{2}/.test(s) && !/(Z|[+-]\d{2}:?\d{2})$/.test(s) ? `${s.replace(' ', 'T')}Z` : s;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

export function toCents(v: unknown): number | null {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[$,]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/** The receipt credits among activity rows: type Receipt (or a "R-" reference) with a readable amount and time. */
export function receiptCreditsOf(rows: BGActivity[]): ReceiptCredit[] {
  const out: ReceiptCredit[] = [];
  for (const r of rows) {
    const ref = String(r.reference_id ?? '');
    const isReceipt = /^receipt$/i.test(String(r.type ?? '').trim()) || (/^R-/i.test(ref) && !/^payment$/i.test(String(r.type ?? '')));
    if (!isReceipt || !ref) continue;
    const cents = toCents(r.amount), at = bgTime(r.created_dt);
    if (cents == null || at == null) continue;
    out.push({ receiptId: bgRefKey(ref), cents, at });
  }
  return out;
}

const SUBSET_CANDIDATES = 40;

/** The one subset of `vals` (positive cents) summing to `target`; null when none or more than one. */
function uniqueSubset(vals: number[], target: number): number[] | null {
  const memo = new Map<string, number>();
  const ways = (i: number, rem: number): number => { // number of subsets of vals[i..] summing to rem, capped at 2
    if (rem === 0) return 1; // (a zero remainder ends the walk; positive-only values mean no later item can be added)
    if (i >= vals.length || rem < 0) return 0;
    const key = `${i}:${rem}`;
    const hit = memo.get(key);
    if (hit != null) return hit;
    const w = Math.min(2, ways(i + 1, rem - vals[i]) + ways(i + 1, rem));
    memo.set(key, w);
    return w;
  };
  if (ways(0, target) !== 1) return null;
  const idx: number[] = [];
  let rem = target;
  for (let i = 0; i < vals.length && rem > 0; i++) {
    if (rem - vals[i] >= 0 && ways(i + 1, rem - vals[i]) > 0) { idx.push(i); rem -= vals[i]; }
  }
  return rem === 0 ? idx : null;
}

export function buildPaymentLedger(credits: ReceiptCredit[], payments: LedgerPaymentIn[]): PaymentLedger {
  const pays = [...payments].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  const assigned = new Set<number>(); // indexes into credits
  const byPayment = new Map<string, string[]>();
  const unassignedPayments: PaymentLedger['unassignedPayments'] = [];
  let prevAt = -Infinity;
  for (const p of pays) {
    const window = credits.map((c, i) => ({ c, i })).filter(x => !assigned.has(x.i) && x.c.at > prevAt && x.c.at <= p.at);
    let pick: number[] | null = window.length > 0 && window.reduce((a, x) => a + x.c.cents, 0) === p.cents ? window.map(x => x.i) : null;
    if (!pick && p.cents > 0) {
      const pool = credits.map((c, i) => ({ c, i })).filter(x => !assigned.has(x.i) && x.c.at <= p.at && x.c.cents > 0)
        .sort((a, b) => b.c.at - a.c.at || a.i - b.i).slice(0, SUBSET_CANDIDATES);
      const hit = uniqueSubset(pool.map(x => x.c.cents), p.cents);
      if (hit) pick = hit.map(k => pool[k].i);
    }
    if (pick && pick.length > 0) {
      for (const i of pick) assigned.add(i);
      byPayment.set(p.id, pick.map(i => credits[i].receiptId));
    } else {
      unassignedPayments.push({ id: p.id, cents: p.cents, windowReceipts: window.map(x => x.c.receiptId) });
    }
    prevAt = p.at;
  }
  const left = credits.filter((_, i) => !assigned.has(i));
  return {
    byPayment,
    unassignedPayments,
    unassignedReceipts: left.map(c => c.receiptId),
    afterLastPayment: left.filter(c => c.at > prevAt).map(c => c.receiptId),
  };
}

/**
 * Cents per tracker order for the receipts one payment covers: each receipt is attributed to its order(s) exactly as the sync does
 * (order number, then tracking), the order's share being the receipt's total; whatever the receipt's activity amount holds above
 * its total (the 5 cent tracking reward) goes to the order with the largest share. The cents add up to the payment. null when a
 * receipt is unknown, maps to no tracker order, or its activity amount is not a few cents over its total.
 */
export function orderCentsOfReceipts(
  receiptIds: string[], receiptByKey: Map<string, unknown>, creditCents: Map<string, number>, orders: AttributionOrder[],
): Map<number, number> | null {
  const out = new Map<number, number>();
  for (const rid of receiptIds) {
    const receipt = receiptByKey.get(rid), rowCents = creditCents.get(rid);
    if (receipt == null || rowCents == null) return null;
    const att = attributeReceipts(orders, [receipt], { creditedOnly: new Set(), syncStartDate: null, cutoff: new Date(0) });
    const ids = [...att.bgMatchedOrderIds].sort((a, b) => a - b);
    if (ids.length === 0) return null;
    const shares = ids.map(id => ({ id, cents: Math.round((att.inBalanceAmountByOrder.get(id) ?? 0) * 100) }));
    const residual = rowCents - shares.reduce((a, x) => a + x.cents, 0);
    if (residual < 0 || residual > 10) return null;
    const top = [...shares].sort((a, b) => b.cents - a.cents || a.id - b.id)[0];
    for (const x of shares) {
      const c = x.cents + (x.id === top.id ? residual : 0);
      if (c > 0) out.set(x.id, (out.get(x.id) ?? 0) + c);
    }
  }
  return out.size > 0 ? out : null;
}
