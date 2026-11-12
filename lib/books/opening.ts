// Opening balances: one `opening` entry dated the day before go-live. Re-running
// replaces it (reversal + new entry, via the reconciler). Orders placed before
// go-live are carried here instead of by purchase postings.
import { cents } from './money.ts';
import { dayBefore } from './dates.ts';
import type { DesiredEntry } from './desired.ts';
import type { LineInput } from './types.ts';
import {
  type OrderForBooks, bestEventDate, cashbackObs, eventsReached, nextCashbackStamp, isGiftCardOrder, orderDay, orderState, returnShares,
} from './orderPostings.ts';

export type OpeningInput = {
  /** Bank / cash accounts: LedgerAccount id and balance in cents. */
  banks: { accountId: number; cents: number }[];
  /** Amount owed per credit card (positive = owed). */
  cards: { cardId: number; cents: number }[];
  /** Loan balances owed. */
  loans: { loanId: number; cents: number }[];
  darkbloomCents: number;
  /** Payouts received but not yet deposited. */
  undepositedCents: number;
};

export const EMPTY_OPENING: OpeningInput = { banks: [], cards: [], loans: [], darkbloomCents: 0, undepositedCents: 0 };

export type OpeningResult = {
  desired: DesiredEntry[];
  stamps: { orderId: number; event: string; date: string; inferred: boolean }[];
  inventoryCents: number;
  receivableCents: number;
};

export function buildOpening(
  orders: OrderForBooks[],
  input: OpeningInput,
  opts: { goLive: string; now: Date; events: Map<number, Map<string, string>> },
): OpeningResult {
  const { goLive, now } = opts;
  const stampDay = dayBefore(goLive);
  const lines: LineInput[] = [];
  const stamps: OpeningResult['stamps'] = [];
  let inventoryCents = 0;
  let receivableCents = 0;

  for (const b of input.banks) if (b.cents) lines.push({ account: b.accountId, amountCents: b.cents, business: 'shared' });
  if (input.undepositedCents) lines.push({ account: 'undeposited_payouts', amountCents: input.undepositedCents });
  if (input.darkbloomCents) lines.push({ account: 'darkbloom_balance', amountCents: input.darkbloomCents, business: 'darkbloom' });
  for (const c of input.cards) if (c.cents) lines.push({ account: `card:${c.cardId}`, amountCents: -c.cents });
  for (const l of input.loans) if (l.cents) lines.push({ account: `loan:${l.loanId}`, amountCents: -l.cents, business: 'shared' });

  for (const o of orders) {
    if (o.cancelled || o.ignoredByRule) continue;
    if (orderDay(o) >= goLive) continue;
    const ev = opts.events.get(o.id) ?? new Map<string, string>();
    // An event counts as "before go-live" unless it was already stamped on/after go-live.
    const stampedHere = new Map(ev);
    for (const e of eventsReached(o, now)) {
      if (!stampedHere.has(e)) {
        const st = bestEventDate(o, e, { goLive, now, hasOpening: false });
        stamps.push({ orderId: o.id, event: e, date: st.date, inferred: st.inferred });
        stampedHere.set(e, st.date);
      }
    }
    const before = (e: string) => !stampedHere.has(e) || stampedHere.get(e)! < goLive;
    const st = orderState(o, now);
    const soldNow = st.sold && before('sold');
    const paidNow = st.paid && before('paid');
    const lostNow = st.lost && before('lost');
    const B = cents((o.cost ?? 0) + (o.shippingCost ?? 0) + (o.insuranceCost ?? 0));
    // Cashback as observed at go-live (the baseline stamp), so a later change posts as a delta, not twice.
    const base = cashbackObs(stampedHere)[0];
    if (!base) {
      const st0 = nextCashbackStamp(o, stampedHere, { goLive, now });
      if (st0) { stamps.push({ orderId: o.id, event: st0.event, date: st0.date, inferred: st0.inferred }); stampedHere.set(st0.event, st0.date); }
    }
    const b0 = cashbackObs(stampedHere)[0];
    const C = b0 ? b0.cb + b0.pc + b0.ax : cents(o.cashbackAmount) + cents(o.portalCashback) + cents(o.amexOfferDollars);
    const buyer = o.buyerId != null ? `buyer:${o.buyerId}` : 'ar_unassigned';
    if (soldNow) {
      if (!paidNow && o.salePrice != null) {
        const s = cents(o.salePrice);
        if (s) { lines.push({ account: buyer, amountCents: s, orderId: o.id, business: 'resell' }); receivableCents += s; }
      }
      continue;
    }
    if (lostNow) continue;
    const shares = returnShares(o);
    const refunded = o.returns.filter(r => r.status === 'refunded' && before(`refunded:${r.id}`)).reduce((s, r) => s + (shares.get(r.id) ?? 0), 0);
    const inv = Math.max(B - C - refunded, 0);
    if (inv) {
      lines.push({ account: isGiftCardOrder(o) ? 'inventory_giftcards' : 'inventory_goods', amountCents: inv, orderId: o.id, business: 'resell' });
      inventoryCents += inv;
    }
  }

  const sum = lines.reduce((s, l) => s + l.amountCents, 0);
  if (sum !== 0) lines.push({ account: 'opening_balance_equity', amountCents: -sum, business: 'shared' });
  const desired: DesiredEntry[] = lines.length === 0 ? [] : [{
    sourceKey: 'opening', date: stampDay, memo: `Opening balances as of ${goLive}`, source: 'opening', lines,
  }];
  return { desired, stamps, inventoryCents, receivableCents };
}
