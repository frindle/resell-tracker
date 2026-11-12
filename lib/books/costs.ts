// Business costs entered by hand. Posts Dr expense (business share) / Dr Owner
// draws (personal share) / Cr the account it was paid from. Voiding reverses it.
import type { DesiredEntry } from './desired.ts';
import type { Business, LineInput } from './types.ts';
import type { BooksStore } from './types.ts';
import { accountForCategory } from './chart.ts';
import { applyDesired, type ReconcileResult } from './reconcile.ts';

export type CostForBooks = {
  id: number;
  business: string; // resell | shared
  date: string;
  amountCents: number;
  category: string;
  vendor: string | null;
  purpose: string | null;
  businessPct: number; // 0..100
  paidFromAccountId: number;
  voidedAt: Date | null;
};

export function desiredCostEntry(c: CostForBooks): DesiredEntry[] {
  if (c.voidedAt) return [];
  const pct = Math.min(100, Math.max(0, Math.round(c.businessPct)));
  const bizPart = Math.round((c.amountCents * pct) / 100);
  const personal = c.amountCents - bizPart;
  const biz = (c.business === 'resell' ? 'resell' : 'shared') as Business;
  const lines: LineInput[] = [];
  if (bizPart) lines.push({ account: accountForCategory(c.category), amountCents: bizPart, business: biz, memo: c.purpose });
  if (personal) lines.push({ account: 'owner_draws', amountCents: personal, business: 'shared', memo: `Personal share (${100 - pct}%)` });
  lines.push({ account: c.paidFromAccountId, amountCents: -c.amountCents, business: 'shared' });
  const who = c.vendor ? ` - ${c.vendor}` : '';
  return [{ sourceKey: `cost:${c.id}`, date: c.date, memo: `Cost: ${c.category}${who} (${pct}% business)`, source: 'cost', lines }];
}

export async function reconcileCosts(store: BooksStore, userId: number, costs: CostForBooks[], now: Date): Promise<ReconcileResult> {
  return applyDesired(store, userId, costs.flatMap(desiredCostEntry), { prefix: 'cost:' }, now);
}
