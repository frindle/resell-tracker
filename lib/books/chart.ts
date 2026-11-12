import type { AccountType, Business } from './types.ts';

export type ChartDef = {
  key: string; // systemKey
  code: string;
  name: string;
  type: AccountType;
  business: Business;
  line?: string; // Schedule C line
};

// Seeded chart, per user. Schedule C line in `line`. "Not tax advice."
export const CHART: ChartDef[] = [
  // Assets (bank accounts are user-created, codes 1000-1099)
  { key: 'undeposited_payouts', code: '1100', name: 'Undeposited payouts', type: 'asset', business: 'resell' },
  { key: 'ar_unassigned', code: '1200', name: 'Receivable - unassigned buyer', type: 'asset', business: 'resell' },
  { key: 'cashback_card_recv', code: '1300', name: 'Card cashback receivable', type: 'asset', business: 'resell' },
  { key: 'cashback_portal_recv', code: '1310', name: 'Portal cashback receivable', type: 'asset', business: 'resell' },
  { key: 'amex_offer_recv', code: '1320', name: 'Amex offer receivable', type: 'asset', business: 'resell' },
  { key: 'inventory_goods', code: '1400', name: 'Inventory - goods', type: 'asset', business: 'resell' },
  { key: 'inventory_giftcards', code: '1410', name: 'Inventory - gift cards', type: 'asset', business: 'resell' },
  { key: 'darkbloom_balance', code: '1500', name: 'Darkbloom balance', type: 'asset', business: 'darkbloom' },
  { key: 'darkbloom_equipment', code: '1600', name: 'Darkbloom equipment', type: 'asset', business: 'darkbloom' },
  { key: 'accum_depreciation', code: '1690', name: 'Accumulated depreciation (contra)', type: 'asset', business: 'darkbloom' },
  // Liabilities (card payable per CreditCard and Loans per Loan are created on demand)
  { key: 'card_unassigned', code: '2000', name: 'Unassigned card payable', type: 'liability', business: 'resell' },
  { key: 'due_to_owner', code: '2500', name: 'Due to owner (costs paid personally)', type: 'liability', business: 'shared' },
  // Equity
  { key: 'opening_balance_equity', code: '3000', name: 'Opening balance equity', type: 'equity', business: 'shared' },
  { key: 'owner_contributions', code: '3100', name: 'Owner contributions', type: 'equity', business: 'shared' },
  { key: 'owner_draws', code: '3200', name: 'Owner draws', type: 'equity', business: 'shared' },
  // Income
  { key: 'sales_resell', code: '4000', name: 'Sales - resell', type: 'income', business: 'resell', line: '1' },
  { key: 'returns_allowances', code: '4100', name: 'Returns and allowances (contra)', type: 'contra_income', business: 'resell', line: '2' },
  { key: 'darkbloom_earnings', code: '4200', name: 'Darkbloom earnings', type: 'income', business: 'darkbloom', line: '1' },
  { key: 'other_income', code: '4300', name: 'Other income', type: 'income', business: 'shared', line: '6' },
  // COGS (Schedule C line 4 / Part III)
  { key: 'cogs_goods', code: '5000', name: 'COGS - goods', type: 'cogs', business: 'resell', line: '4' },
  { key: 'cogs_giftcards', code: '5010', name: 'COGS - gift cards', type: 'cogs', business: 'resell', line: '4' },
  { key: 'inventory_loss', code: '5100', name: 'Inventory loss', type: 'cogs', business: 'resell', line: '4' },
  // Expenses
  { key: 'exp_commissions', code: '6000', name: 'Commissions and fees', type: 'expense', business: 'shared', line: '10' },
  { key: 'exp_depreciation', code: '6100', name: 'Depreciation', type: 'expense', business: 'darkbloom', line: '13' },
  { key: 'exp_interest', code: '6200', name: 'Interest', type: 'expense', business: 'shared', line: '16b' },
  { key: 'exp_office_software', code: '6300', name: 'Office / software', type: 'expense', business: 'shared', line: '18' },
  { key: 'exp_equipment_lease', code: '6400', name: 'Equipment lease', type: 'expense', business: 'darkbloom', line: '20a' },
  { key: 'exp_supplies_postage', code: '6500', name: 'Supplies and postage', type: 'expense', business: 'shared', line: '22' },
  { key: 'exp_utilities', code: '6600', name: 'Utilities - electricity and internet', type: 'expense', business: 'shared', line: '25' },
  { key: 'exp_other', code: '6900', name: 'Other expenses', type: 'expense', business: 'shared', line: '27a' },
];

export const CHART_BY_KEY = new Map(CHART.map(c => [c.key, c]));

/** Cost-form / bloom-ledger entry categories mapped onto expense accounts. */
export const CATEGORY_ACCOUNT: Record<string, string> = {
  supplies: 'exp_supplies_postage',
  postage: 'exp_supplies_postage',
  software: 'exp_office_software',
  fees: 'exp_commissions',
  internet: 'exp_utilities',
  electricity: 'exp_utilities',
  // De minimis safe harbor expensing; flag for the CPA.
  hardware: 'exp_supplies_postage',
  interest: 'exp_interest',
  other: 'exp_other',
};

export const COST_CATEGORIES = Object.keys(CATEGORY_ACCOUNT);

export function accountForCategory(category: string): string {
  return CATEGORY_ACCOUNT[category] ?? 'exp_other';
}

/** Definition for a per-card / per-buyer / per-loan account key, given the entity's name. */
export function dynamicAccountDef(key: string, name: string): (ChartDef & { creditCardId?: number; buyerId?: number; loanId?: number }) | null {
  const m = /^(card|buyer|loan):(\d+)$/.exec(key);
  if (!m) return null;
  const id = Number(m[2]);
  if (m[1] === 'card') return { key, code: `2100-${id}`, name: `Card payable - ${name}`, type: 'liability', business: 'resell', creditCardId: id };
  if (m[1] === 'buyer') return { key, code: `1210-${id}`, name: `Receivable - ${name}`, type: 'asset', business: 'resell', buyerId: id };
  return { key, code: `2300-${id}`, name: `Loan - ${name}`, type: 'liability', business: 'shared', loanId: id };
}

/** Next free bank / cash account code in 1000-1099; throws when the range is full (never reuses a code). */
export function nextBankCode(used: Set<string>): string {
  for (let n = 1000; n <= 1099; n++) if (!used.has(String(n))) return String(n);
  throw new Error('bank account codes 1000-1099 are all in use');
}
