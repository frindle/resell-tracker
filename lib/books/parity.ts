// Parity check: for each settled order dated on/after go-live, the books' income /
// contra-income / COGS lines must equal -(calcStats orderProfit), to the cent.
// Lines tagged [known:...] are reported as known differences, not errors.
import { calcStats } from '../analytics.ts';
import { cents } from './money.ts';
import { monthOf } from './dates.ts';
import type { LedgerLineRow } from './types.ts';
import { type OrderForBooks, isKnownTag, orderDay, orderState } from './orderPostings.ts';

export type ParityStatus = 'match' | 'mismatch' | 'timing';
export type ParityRow = {
  orderId: number;
  platform: string;
  status: ParityStatus;
  expectedCents: number; // -profit
  actualCents: number; // untagged income/contra/cogs lines
  diffCents: number;
  knownCents: number; // tagged lines
  note: string;
};

const PNL = new Set(['income', 'contra_income', 'cogs']);

export function statsFor(o: OrderForBooks) {
  return calcStats([{
    salePrice: o.salePrice, cost: o.cost, shippingCost: o.shippingCost, insuranceCost: o.insuranceCost ?? 0,
    returnedCost: o.returnedCost ?? 0, cashbackAmount: o.cashbackAmount, portalCashback: o.portalCashback,
    amexOfferDollars: o.amexOfferDollars, amexOfferPoints: null, platform: o.platform, card: null,
  }]);
}

const analyticsExcluded = (o: OrderForBooks) => o.cancelled || o.ignoredByRule;

export function parityCheck(orders: OrderForBooks[], lines: LedgerLineRow[], goLive: string, now: Date): ParityRow[] {
  const byOrder = new Map<number, LedgerLineRow[]>();
  for (const l of lines) if (l.orderId != null) (byOrder.get(l.orderId) ?? byOrder.set(l.orderId, []).get(l.orderId)!).push(l);
  const rows: ParityRow[] = [];
  for (const o of orders) {
    if (analyticsExcluded(o) || orderDay(o) < goLive) continue;
    const st = orderState(o, now);
    const ls = (byOrder.get(o.id) ?? []).filter(l => PNL.has(l.type));
    const actual = ls.filter(l => !isKnownTag(l.memo)).reduce((s, l) => s + l.amountCents, 0);
    const known = ls.filter(l => isKnownTag(l.memo)).reduce((s, l) => s + l.amountCents, 0);
    const expected = -cents(statsFor(o).profit);
    const settled = st.sold || st.lost;
    const returnsOpen = o.returns.some(r => r.status !== 'rejected' && r.status !== 'refunded');
    let status: ParityStatus;
    let note = '';
    if (!settled) { status = 'timing'; note = 'not sold yet: analytics counts the cost now, the books carry it as inventory'; }
    else if (returnsOpen) { status = 'timing'; note = 'return in flight'; }
    else {
      status = actual === expected ? 'match' : 'mismatch';
      if (known) note = `known difference ${known} cents (tagged)`;
    }
    rows.push({ orderId: o.id, platform: o.platform, status, expectedCents: expected, actualCents: actual, diffCents: actual - expected, knownCents: known, note });
  }
  return rows;
}

export type PeriodRow = { month: string; analyticsCents: number; booksCents: number; diffCents: number };

/** Month by month: analytics (by order date) vs the books (by event date). Differences here are timing. */
export function periodView(orders: OrderForBooks[], lines: LedgerLineRow[], goLive: string): PeriodRow[] {
  const a = new Map<string, number>();
  const b = new Map<string, number>();
  for (const o of orders) {
    if (analyticsExcluded(o) || orderDay(o) < goLive) continue;
    const m = monthOf(orderDay(o));
    a.set(m, (a.get(m) ?? 0) - cents(statsFor(o).profit));
  }
  for (const l of lines) {
    if (!PNL.has(l.type) || l.orderId == null || l.date < goLive) continue;
    const m = monthOf(l.date);
    b.set(m, (b.get(m) ?? 0) + l.amountCents);
  }
  const months = [...new Set([...a.keys(), ...b.keys()])].sort();
  return months.map(m => ({ month: m, analyticsCents: a.get(m) ?? 0, booksCents: b.get(m) ?? 0, diffCents: (b.get(m) ?? 0) - (a.get(m) ?? 0) }));
}
