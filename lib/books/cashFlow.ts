// Cash flow by month, direct method. Cash = asset accounts coded 1000-1099 (bank and cash accounts the user created).
// Each entry's cash movement is split by what sits opposite it: an opposite line's negated amount is its cash effect.
// Transfers between two cash accounts net to zero and drop out. Reads ledger lines only.
import type { LedgerLineRow } from './types.ts';
import { monthOf } from './dates.ts';

export type CashFlowMonth = {
  month: string;
  beginCents: number;
  operatingCents: number; // sales, payouts, inventory, costs, card payments
  investingCents: number; // equipment
  financingCents: number; // loans, owner contributions and draws, due to owner
  openingCents: number; // opening balances posted as cash (the go-live entry)
  netCents: number;
  endCents: number;
};

export const isCashLine = (l: Pick<LedgerLineRow, 'code' | 'type'>) => l.type === 'asset' && /^10\d\d$/.test(l.code);

type Cat = 'operating' | 'investing' | 'financing' | 'opening';
function category(l: LedgerLineRow): Cat {
  if (l.systemKey === 'opening_balance_equity') return 'opening';
  if (l.systemKey === 'darkbloom_equipment') return 'investing';
  if (l.type === 'equity' || l.systemKey === 'due_to_owner' || (l.systemKey ?? '').startsWith('loan:')) return 'financing';
  return 'operating';
}

export function cashFlowByMonth(lines: LedgerLineRow[]): CashFlowMonth[] {
  const byEntry = new Map<number, LedgerLineRow[]>();
  for (const l of lines) {
    const a = byEntry.get(l.entryId);
    if (a) a.push(l); else byEntry.set(l.entryId, [l]);
  }
  const months = new Map<string, CashFlowMonth>();
  for (const ls of byEntry.values()) {
    if (!ls.some(isCashLine)) continue;
    const m = monthOf(ls[0].date);
    let row = months.get(m);
    if (!row) { row = { month: m, beginCents: 0, operatingCents: 0, investingCents: 0, financingCents: 0, openingCents: 0, netCents: 0, endCents: 0 }; months.set(m, row); }
    for (const l of ls) {
      if (isCashLine(l)) continue;
      const c = -l.amountCents;
      const cat = category(l);
      if (cat === 'operating') row.operatingCents += c;
      else if (cat === 'investing') row.investingCents += c;
      else if (cat === 'financing') row.financingCents += c;
      else row.openingCents += c;
    }
  }
  const out = [...months.values()].sort((a, b) => a.month.localeCompare(b.month));
  let run = 0;
  for (const r of out) {
    r.beginCents = run;
    r.netCents = r.operatingCents + r.investingCents + r.financingCents + r.openingCents;
    run += r.netCents;
    r.endCents = run;
  }
  return out;
}

/** Total cash balance (cents) as of a date, straight from the lines: what the last month's end should tie to. */
export function cashBalance(lines: LedgerLineRow[], asOf?: string): number {
  return lines.filter(l => isCashLine(l) && (!asOf || l.date <= asOf)).reduce((s, l) => s + l.amountCents, 0);
}
