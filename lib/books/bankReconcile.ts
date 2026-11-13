// Reconciling a mapped account for one month. Pure: no database.
//
// Statement balance at month end = the earliest StatementBalance on or after the month end, minus the non-pending rows
// posted between the month end and that date. Books balance = the mapped ledger account as of the month end.
// Both use the account's own sign (a card that owes money is negative), so they compare directly.
// Items in transit explain a difference; each has an `effectCents`, its contribution to (books - statement):
//   - an open row (unmatched / suggested) dated on or before the month end: on the statement, not in the books: -amount
//   - an order purchase on this card with no charge row yet by the month end, still inside the charge window: -remaining
//   - a transfer whose other row is on or before the month end but this row is after it: the single entry is dated the
//     earlier row, so this account's books are ahead of its statement: +this row's amount
// A month ties when books - statement - explained = 0.
import { dayDiff, CHARGE_MAX_DAYS } from './match.ts';

export type StatementPoint = { date: string; balanceCents: number; source: string };
export type RecRow = { id: number; postedDate: string; amountCents: number; pending: boolean; matchStatus: string; description: string };
export type RecPurchase = {
  orderId: number;
  /** The date the purchase was booked. */
  day: string;
  purchaseCents: number; // positive: what the card was credited
  /** Charge rows linked to this order on this account: when each posted, and how much of it is this order's. */
  charges: { postedDate: string; cents: number }[];
};
export type RecTransferLeg = { txnId: number; postedDate: string; amountCents: number; partnerPostedDate: string };

export type RecItem = { kind: 'open_row' | 'order_in_transit' | 'transfer_in_transit'; id: number; label: string; effectCents: number };
export type RecStatus = 'tied' | 'explained' | 'unexplained' | 'no_balance' | 'empty';
export type RecResult = {
  accountId: number;
  month: string;
  monthEnd: string;
  status: RecStatus;
  statementCents: number | null;
  statementAsOf: string | null;
  statementSource: string | null;
  booksCents: number;
  diffCents: number | null;
  explainedCents: number;
  unexplainedCents: number | null;
  items: RecItem[];
};

const SOURCE_RANK: Record<string, number> = { manual: 0, ofx: 1, simplefin: 2 };

export function statementAtMonthEnd(points: StatementPoint[], rows: RecRow[], monthEnd: string): { cents: number; asOf: string; source: string } | null {
  const later = points.filter(p => p.date >= monthEnd);
  if (later.length === 0) return null;
  later.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (SOURCE_RANK[a.source] ?? 9) - (SOURCE_RANK[b.source] ?? 9)));
  const p = later[0];
  let cents = p.balanceCents;
  for (const r of rows) if (!r.pending && r.postedDate > monthEnd && r.postedDate <= p.date) cents -= r.amountCents;
  return { cents, asOf: p.date, source: p.source };
}

export function reconcileMonth(a: {
  accountId: number; month: string; monthEnd: string; goLive: string;
  statements: StatementPoint[]; rows: RecRow[]; booksCents: number;
  purchases?: RecPurchase[]; transfers?: RecTransferLeg[];
}): RecResult {
  const st = statementAtMonthEnd(a.statements, a.rows, a.monthEnd);
  const items: RecItem[] = [];
  for (const r of a.rows) {
    if (r.pending || r.postedDate > a.monthEnd || r.postedDate < a.goLive) continue;
    if (r.matchStatus === 'unmatched' || r.matchStatus === 'suggested') {
      items.push({ kind: 'open_row', id: r.id, label: `${r.postedDate} ${r.description}`, effectCents: -r.amountCents });
    }
  }
  for (const p of a.purchases ?? []) {
    if (p.day > a.monthEnd) continue;
    const charged = p.charges.filter(c => c.postedDate <= a.monthEnd).reduce((s, c) => s + c.cents, 0);
    const remaining = p.purchaseCents - charged;
    if (remaining <= 0) continue;
    const chargeAfter = p.charges.some(c => c.postedDate > a.monthEnd);
    if (!chargeAfter && dayDiff(p.day, a.monthEnd) > CHARGE_MAX_DAYS) continue; // past the window: it should have been charged
    items.push({ kind: 'order_in_transit', id: p.orderId, label: `order #${p.orderId} bought ${p.day}, charge not on the statement yet`, effectCents: -remaining });
  }
  for (const t of a.transfers ?? []) {
    if (t.postedDate > a.monthEnd && t.partnerPostedDate <= a.monthEnd) {
      items.push({ kind: 'transfer_in_transit', id: t.txnId, label: `transfer on ${t.postedDate}, other side on ${t.partnerPostedDate}`, effectCents: t.amountCents });
    }
  }
  const explained = items.reduce((s, i) => s + i.effectCents, 0);
  const base = {
    accountId: a.accountId, month: a.month, monthEnd: a.monthEnd, booksCents: a.booksCents, items,
  };
  if (!st) {
    const quiet = a.booksCents === 0 && !a.rows.some(r => r.postedDate <= a.monthEnd);
    return { ...base, status: quiet ? 'empty' : 'no_balance', statementCents: null, statementAsOf: null, statementSource: null, diffCents: null, explainedCents: explained, unexplainedCents: null };
  }
  const diff = a.booksCents - st.cents;
  const unexplained = diff - explained;
  const status: RecStatus = unexplained !== 0 ? 'unexplained' : explained !== 0 ? 'explained' : 'tied';
  return { ...base, status, statementCents: st.cents, statementAsOf: st.asOf, statementSource: st.source, diffCents: diff, explainedCents: explained, unexplainedCents: unexplained };
}

/** Ties for the lock gate: tied or explained. `empty` accounts (nothing to reconcile) pass too. */
export const recOk = (s: RecStatus) => s === 'tied' || s === 'explained' || s === 'empty';
