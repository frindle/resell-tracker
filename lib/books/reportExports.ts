// CSV for each report. Amounts are plain decimal dollars from integer cents.
import { decimalCents as d } from './money.ts';
import { toCsv } from './csv.ts';
import type { BalanceSheet } from './balanceSheet.ts';
import type { CashFlowMonth } from './cashFlow.ts';
import type { InventoryReport } from './inventory.ts';
import type { ScheduleC } from './scheduleC.ts';
import { SCHEDULE_C_DISCLAIMER } from './scheduleC.ts';
import type { K1099Row } from './k1099.ts';
import type { PnlRow, TrialRow } from './reports.ts';

export function balanceSheetCsv(b: BalanceSheet): string {
  const sec = (name: string, rows: BalanceSheet['assets']) => rows.map(r => [name, r.code, r.name, d(r.cents)]);
  return toCsv(['Section', 'Code', 'Account', `Balance as of ${b.asOf}`], [
    ...sec('Assets', b.assets), ['Assets', '', 'Total assets', d(b.totalAssetsCents)],
    ...sec('Liabilities', b.liabilities), ['Liabilities', '', 'Total liabilities', d(b.totalLiabilitiesCents)],
    ...sec('Equity', b.equity), ['Equity', '', 'Total equity', d(b.totalEquityCents)],
    ['Check', '', 'Assets - liabilities - equity', d(b.differenceCents)],
  ]);
}

export function cashFlowCsv(rows: CashFlowMonth[]): string {
  return toCsv(['Month', 'Beginning cash', 'Operating', 'Investing', 'Financing', 'Opening balances', 'Net change', 'Ending cash'],
    rows.map(r => [r.month, d(r.beginCents), d(r.operatingCents), d(r.investingCents), d(r.financingCents), d(r.openingCents), d(r.netCents), d(r.endCents)]));
}

export type InventoryLabels = Map<number, string>;
export function inventoryCsv(r: InventoryReport, labels: InventoryLabels = new Map()): string {
  return toCsv(['Order', 'Description', 'Acquired', 'Age (days)', 'Age bucket', 'Goods', 'Gift cards', 'Value'],
    [...r.lots.map(l => [l.orderId == null ? 'no order' : l.orderId, l.orderId != null ? labels.get(l.orderId) ?? '' : '', l.acquired, l.ageDays, l.bucket, d(l.goodsCents), d(l.giftCardsCents), d(l.valueCents)]),
      ['TOTAL', `as of ${r.asOf}`, '', '', '', '', '', d(r.totalCents)],
      ['LEDGER', 'Inventory accounts 1400 + 1410', '', '', '', '', '', d(r.accountBalanceCents)]]);
}

export function scheduleCCsv(s: ScheduleC): string {
  const rows: (string | number)[][] = [
    ['1', 'Gross receipts or sales', d(s.line1Cents)], ['2', 'Returns and allowances', d(s.line2Cents)], ['3', 'Subtract line 2 from line 1', d(s.line3Cents)],
    ['4', 'Cost of goods sold', d(s.line4Cents)], ['5', 'Gross profit', d(s.line5Cents)], ['6', 'Other income', d(s.line6Cents)], ['7', 'Gross income', d(s.line7Cents)],
    ...s.expenses.map(e => [e.line, e.label, d(e.cents)]),
    ['28', 'Total expenses', d(s.line28Cents)], ['31', 'Net profit or loss', d(s.line31Cents)],
    ['35', 'Part III: inventory at beginning of year', d(s.partIII.beginInventoryCents)],
    ['36', 'Part III: purchases (derived)', d(s.partIII.purchasesCents)],
    ['41', 'Part III: inventory at end of year', d(s.partIII.endInventoryCents)],
    ['42', 'Part III: cost of goods sold', d(s.partIII.cogsCents)],
  ];
  return toCsv([`Schedule C line (${s.business}, ${s.year})`, 'Description', 'Amount'], [...rows, ['note', SCHEDULE_C_DISCLAIMER, ''], ...s.notes.slice(1).map(n => ['note', n, ''])]);
}

export function k1099Csv(rows: K1099Row[]): string {
  return toCsv(['Year', 'Payer', 'Payer keys', '1099-K amount', 'Transactions', 'Books gross receipts', 'Difference (form - books)', 'Books received from payer', 'Status', 'Meets $20,000 and 200 reference', 'Note'],
    rows.map(r => [r.year, r.payerName, r.payerKeys, d(r.amountCents), r.transactions, d(r.booksGrossCents), d(r.differenceCents), d(r.booksReceivedCents), r.status, r.reference.meets == null ? 'count not entered' : r.reference.meets ? 'yes' : 'no', r.note]));
}

export function trialCsv(rows: TrialRow[]): string {
  return toCsv(['Code', 'Account', 'Type', 'Balance (debit +, credit -)'], rows.map(r => [r.code, r.name, r.type, d(r.balanceCents)]));
}

export function pnlCsv(rows: PnlRow[]): string {
  return toCsv(['Month', 'Business', 'Income', 'COGS', 'Expenses', 'Net'], rows.map(r => [r.month, r.business, d(r.incomeCents), d(r.cogsCents), d(r.expenseCents), d(r.netCents)]));
}
