// Balance sheet as of a date. Reads ledger lines only. Assets are debit balances; liabilities and equity are shown
// positive (credit balance). With no year-end close, income and expense accounts roll into two earnings rows.
import type { LedgerLineRow } from './types.ts';

export type BsRow = { accountId: number; code: string; name: string; cents: number };
export type BalanceSheet = {
  asOf: string;
  assets: BsRow[];
  liabilities: BsRow[];
  equity: BsRow[]; // includes the earnings rows (code '')
  totalAssetsCents: number;
  totalLiabilitiesCents: number;
  totalEquityCents: number;
  /** assets - (liabilities + equity): 0 whenever every entry balanced. */
  differenceCents: number;
};

const byCode = (a: BsRow, b: BsRow) => a.code.localeCompare(b.code, undefined, { numeric: true });
const PNL = new Set(['income', 'contra_income', 'cogs', 'expense']);

export function balanceSheet(lines: LedgerLineRow[], asOf: string): BalanceSheet {
  const yearStart = `${asOf.slice(0, 4)}-01-01`;
  const acct = new Map<number, BsRow & { type: string }>();
  let priorEarn = 0; // credit-positive
  let ytdEarn = 0;
  for (const l of lines) {
    if (l.date > asOf) continue;
    if (PNL.has(l.type)) {
      if (l.date < yearStart) priorEarn -= l.amountCents; else ytdEarn -= l.amountCents;
      continue;
    }
    const r = acct.get(l.accountId) ?? { accountId: l.accountId, code: l.code, name: l.accountName, cents: 0, type: l.type };
    r.cents += l.amountCents;
    acct.set(l.accountId, r);
  }
  const rows = [...acct.values()].filter(r => r.cents !== 0);
  const pick = (type: string, sign: 1 | -1): BsRow[] =>
    rows.filter(r => r.type === type).map(r => ({ accountId: r.accountId, code: r.code, name: r.name, cents: sign * r.cents })).sort(byCode);
  const assets = pick('asset', 1);
  const liabilities = pick('liability', -1);
  const equity = pick('equity', -1);
  if (priorEarn !== 0) equity.push({ accountId: 0, code: '', name: 'Earnings, prior years (not closed)', cents: priorEarn });
  if (ytdEarn !== 0) equity.push({ accountId: 0, code: '', name: `Earnings, ${asOf.slice(0, 4)} to date`, cents: ytdEarn });
  const sum = (r: BsRow[]) => r.reduce((s, x) => s + x.cents, 0);
  const a = sum(assets), li = sum(liabilities), eq = sum(equity);
  return { asOf, assets, liabilities, equity, totalAssetsCents: a, totalLiabilitiesCents: li, totalEquityCents: eq, differenceCents: a - li - eq };
}
