import type { AccountType, Business, LedgerLineRow } from './types.ts';
import { monthOf } from './dates.ts';

export type TrialRow = { accountId: number; code: string; name: string; type: AccountType; balanceCents: number };

/** Balance per account across all lines (debit +, credit -). Sums to 0. */
export function trialBalance(lines: LedgerLineRow[]): { rows: TrialRow[]; totalCents: number } {
  const m = new Map<number, TrialRow>();
  for (const l of lines) {
    const r = m.get(l.accountId) ?? { accountId: l.accountId, code: l.code, name: l.accountName, type: l.type, balanceCents: 0 };
    r.balanceCents += l.amountCents;
    m.set(l.accountId, r);
  }
  const rows = [...m.values()].filter(r => r.balanceCents !== 0).sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  return { rows, totalCents: rows.reduce((s, r) => s + r.balanceCents, 0) };
}

export type PnlRow = { month: string; business: Business; incomeCents: number; cogsCents: number; expenseCents: number; netCents: number };

/** Profit and loss by month and business. Amounts are positive for income and costs; net = income - cogs - expenses. */
export function pnlByMonth(lines: LedgerLineRow[]): PnlRow[] {
  const m = new Map<string, PnlRow>();
  for (const l of lines) {
    if (l.type !== 'income' && l.type !== 'contra_income' && l.type !== 'cogs' && l.type !== 'expense') continue;
    const key = `${monthOf(l.date)}|${l.business}`;
    const r = m.get(key) ?? { month: monthOf(l.date), business: l.business, incomeCents: 0, cogsCents: 0, expenseCents: 0, netCents: 0 };
    if (l.type === 'income' || l.type === 'contra_income') r.incomeCents -= l.amountCents;
    else if (l.type === 'cogs') r.cogsCents += l.amountCents;
    else r.expenseCents += l.amountCents;
    m.set(key, r);
  }
  const rows = [...m.values()];
  for (const r of rows) r.netCents = r.incomeCents - r.cogsCents - r.expenseCents;
  return rows.sort((a, b) => a.month.localeCompare(b.month) || a.business.localeCompare(b.business));
}
