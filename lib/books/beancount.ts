// Beancount export of the journal, an independent check: load it with bean-check / bean-report and compare balances
// with the trial balance here. Every entry (reversals included) becomes one transaction; debit is +, credit is -, the
// same sign Beancount uses (assets +, income -). A balance assertion per account is written the day after the last entry.
import type { LedgerLineRow } from './types.ts';

const ROOT: Record<string, string> = {
  asset: 'Assets', liability: 'Liabilities', equity: 'Equity', income: 'Income', contra_income: 'Income', cogs: 'Expenses:Cogs', expense: 'Expenses',
};

export function beancountAccount(l: Pick<LedgerLineRow, 'type' | 'code' | 'accountName'>): string {
  const name = l.accountName.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `${ROOT[l.type] ?? 'Equity'}:${l.code.replace(/[^A-Za-z0-9]+/g, '-')}${name ? `-${name}` : ''}`;
}

const amt = (c: number) => `${c < 0 ? '-' : ''}${Math.floor(Math.abs(c) / 100)}.${String(Math.abs(c) % 100).padStart(2, '0')} USD`;
const q = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ')}"`;

export function dayAfter(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function toBeancount(lines: LedgerLineRow[]): string {
  const out: string[] = [
    '; Resell tracker books, exported as Beancount. A bookkeeping estimate, not tax advice.',
    '; Check: bean-check this file; its balances should equal the trial balance.',
    'option "title" "Resell tracker books"',
    'option "operating_currency" "USD"',
    '',
  ];
  if (lines.length === 0) return out.join('\n') + '\n';
  const byEntry = new Map<number, LedgerLineRow[]>();
  for (const l of lines) {
    const a = byEntry.get(l.entryId);
    if (a) a.push(l); else byEntry.set(l.entryId, [l]);
  }
  const entries = [...byEntry.entries()].sort((a, b) => a[1][0].date.localeCompare(b[1][0].date) || a[0] - b[0]);
  const names = new Map<number, string>();
  const used = new Set<string>();
  for (const l of lines) {
    let n = beancountAccount(l);
    if (!names.has(l.accountId)) {
      while (used.has(n) && names.get(l.accountId) !== n) n += '-x';
      names.set(l.accountId, n);
      used.add(n);
    }
  }
  const first = entries[0][1][0].date;
  for (const n of [...new Set(names.values())].sort()) out.push(`${first} open ${n} USD`);
  out.push('');
  const bal = new Map<number, number>();
  let last = first;
  for (const [id, ls] of entries) {
    const date = ls[0].date;
    if (date > last) last = date;
    out.push(`${date} * ${q(ls[0].entryMemo)}`);
    out.push(`  entry: ${id}`);
    out.push(`  source: ${q(ls[0].sourceKey)}`);
    for (const l of ls) {
      out.push(`  ${names.get(l.accountId)}  ${amt(l.amountCents)}`);
      if (l.orderId != null) out.push(`    orderId: ${l.orderId}`);
      bal.set(l.accountId, (bal.get(l.accountId) ?? 0) + l.amountCents);
    }
    out.push('');
  }
  const check = dayAfter(last);
  for (const [accountId, c] of [...bal.entries()].sort((a, b) => names.get(a[0])!.localeCompare(names.get(b[0])!))) {
    out.push(`${check} balance ${names.get(accountId)}  ${amt(c)}`);
  }
  return out.join('\n') + '\n';
}
