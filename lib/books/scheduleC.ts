// Schedule C worksheet, one per business, from the chart's Schedule C line mapping. An ESTIMATE for the CPA to review,
// not a tax return and not tax advice. Reads ledger lines only. Calendar year, books basis as posted.
//
// Business of a line = the line's own business tag, else its account's. Lines tagged "shared" (costs entered as shared)
// are counted on the Resell worksheet and listed separately in `sharedIncludedCents`, because the books hold no
// split rule for them. Darkbloom lines come from the monthly tally and are tagged darkbloom.
import type { LedgerLineRow } from './types.ts';
import { CHART_BY_KEY } from './chart.ts';

export type ScheduleCBusiness = 'resell' | 'darkbloom';

export type ScheduleCExpense = { line: string; label: string; cents: number };
export type ScheduleC = {
  business: ScheduleCBusiness;
  year: number;
  line1Cents: number; // gross receipts
  line2Cents: number; // returns and allowances
  line3Cents: number;
  line4Cents: number; // cost of goods sold
  line5Cents: number;
  line6Cents: number; // other income
  line7Cents: number; // gross income
  expenses: ScheduleCExpense[];
  line28Cents: number; // total expenses
  line31Cents: number; // net profit or loss
  partIII: { beginInventoryCents: number; purchasesCents: number; endInventoryCents: number; cogsCents: number };
  sharedIncludedCents: number; // net effect of shared-tagged P&L lines folded into this worksheet (Resell only)
  unmappedCents: number; // P&L lines on accounts with no Schedule C line (not in any total above)
  notes: string[];
};

export const SCHEDULE_C_DISCLAIMER = 'Estimate for your CPA to review. Not tax advice and not a filed return.';

const EXPENSE_LABELS: Record<string, string> = {
  '10': 'Commissions and fees', '13': 'Depreciation and section 179', '16b': 'Interest (other)', '18': 'Office expense',
  '20a': 'Rent or lease (vehicles, machinery, equipment)', '22': 'Supplies', '25': 'Utilities', '27a': 'Other expenses',
};
const LINE_ORDER = ['10', '13', '16b', '18', '20a', '22', '25', '27a'];

export function scheduleC(lines: LedgerLineRow[], year: number, business: ScheduleCBusiness): ScheduleC {
  const from = `${year}-01-01`, to = `${year}-12-31`;
  const bizOf = (l: LedgerLineRow) => (l.business === 'darkbloom' ? 'darkbloom' : 'resell');
  const lineOf = (l: LedgerLineRow) => (l.systemKey ? CHART_BY_KEY.get(l.systemKey)?.line : undefined);
  let l1 = 0, l2 = 0, l4 = 0, l6 = 0, shared = 0, unmapped = 0;
  const exp = new Map<string, number>();
  let begin = 0, end = 0;
  for (const l of lines) {
    if (bizOf(l) !== business) continue;
    const inv = l.systemKey === 'inventory_goods' || l.systemKey === 'inventory_giftcards';
    if (inv) {
      if (l.date < from) begin += l.amountCents;
      if (l.date <= to) end += l.amountCents;
      continue;
    }
    if (l.date < from || l.date > to) continue;
    if (l.type !== 'income' && l.type !== 'contra_income' && l.type !== 'cogs' && l.type !== 'expense') continue;
    const ln = lineOf(l);
    if (!ln) { unmapped += l.amountCents; continue; }
    if (l.business === 'shared') shared -= l.amountCents; // effect on profit: credits add, debits subtract
    if (l.type === 'income') { if (ln === '6') l6 -= l.amountCents; else l1 -= l.amountCents; }
    else if (l.type === 'contra_income') l2 += l.amountCents;
    else if (l.type === 'cogs') l4 += l.amountCents;
    else exp.set(ln, (exp.get(ln) ?? 0) + l.amountCents);
  }
  const l3 = l1 - l2, l5 = l3 - l4, l7 = l5 + l6;
  const expenses: ScheduleCExpense[] = [...exp.entries()]
    .filter(([, c]) => c !== 0)
    .sort((a, b) => (LINE_ORDER.indexOf(a[0]) + 1 || 99) - (LINE_ORDER.indexOf(b[0]) + 1 || 99))
    .map(([line, cents]) => ({ line, label: EXPENSE_LABELS[line] ?? `Line ${line}`, cents }));
  const l28 = expenses.reduce((s, e) => s + e.cents, 0);
  const notes = [SCHEDULE_C_DISCLAIMER];
  if (business === 'resell') notes.push('Shared costs are included here in full; the books have no split between the two businesses. Your CPA decides any allocation.');
  if (business === 'darkbloom') notes.push('Darkbloom figures come from the monthly tally. Depreciation is the tally\'s number, not a Form 4562 schedule.');
  notes.push('Hardware under the de minimis safe harbor is booked as supplies (line 22). Gift cards held to resell are booked as inventory. Both are CPA questions.');
  notes.push('Part III is derived: purchases = cost of goods sold + ending inventory - beginning inventory. Inventory is specific-ID, each order its own lot.');
  if (unmapped !== 0) notes.push('Some income or expense lines sit on accounts with no Schedule C line and are left out of every total here.');
  return {
    business, year, line1Cents: l1, line2Cents: l2, line3Cents: l3, line4Cents: l4, line5Cents: l5, line6Cents: l6, line7Cents: l7,
    expenses, line28Cents: l28, line31Cents: l7 - l28,
    partIII: { beginInventoryCents: begin, purchasesCents: l4 + end - begin, endInventoryCents: end, cogsCents: l4 },
    sharedIncludedCents: business === 'resell' ? shared : 0, unmappedCents: unmapped, notes,
  };
}
