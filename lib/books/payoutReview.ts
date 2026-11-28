// Payout review (Books P3 step 3c). Pure: no database. Deposits link to orders with `payout` links (amount = cash that
// cleared that order). A deposit that covers less than the orders' open amounts keeps the difference in the link's note
// (`short=<cents>`); the user then classifies it, which writes a `payout_shortfall` link per order (note
// `shortfall:fee|returns|more`, amount = that short). A distinct kind, because BankMatch is unique on (txn, kind, order) and
// the order already has its `payout` link on that row; it also keeps the payout links adding up to the deposit exactly.
import { dayDiff } from './match.ts';
import { shortfallClass } from './bankPostings.ts';

export type PayoutLink = { txnId: number; kind: string; refId: number; amountCents: number; note?: string | null };

export const AGING_DAYS = 21;

export const shortNote = (cents: number): string | undefined => (cents > 0 ? `short=${cents}` : undefined);
export const parseShort = (note: string | null | undefined): number => Number(/(?:^|,)short=(\d+)/.exec(note ?? '')?.[1] ?? 0);

/** order id -> cents cleared: cash deposited plus fee / returns shortfalls. "More coming" clears nothing; a negative part (a fee clawback) clears nothing and never reopens an order. */
export function clearedByOrder(links: PayoutLink[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const l of links) {
    if (l.amountCents < 0) continue;
    const counts = l.kind === 'payout' || (l.kind === 'payout_shortfall' && (shortfallClass(l.note) === 'fee' || shortfallClass(l.note) === 'returns'));
    if (counts) out.set(l.refId, (out.get(l.refId) ?? 0) + l.amountCents);
  }
  return out;
}

export type DepositShortfall = { txnId: number; shortCents: number; orders: { orderId: number; shortCents: number }[] };

/** Deposits whose payout links carry a short that no `payout_shortfall` link has classified yet. */
export function openDepositShortfalls(links: PayoutLink[]): DepositShortfall[] {
  const resolved = new Set(links.filter(l => l.kind === 'payout_shortfall').map(l => `${l.txnId}:${l.refId}`));
  const byTxn = new Map<number, DepositShortfall>();
  for (const l of links) {
    if (l.kind !== 'payout') continue;
    const short = parseShort(l.note);
    if (short <= 0 || resolved.has(`${l.txnId}:${l.refId}`)) continue;
    const d = byTxn.get(l.txnId) ?? { txnId: l.txnId, shortCents: 0, orders: [] };
    d.shortCents += short;
    d.orders.push({ orderId: l.refId, shortCents: short });
    byTxn.set(l.txnId, d);
  }
  return [...byTxn.values()].sort((a, b) => a.txnId - b.txnId);
}

export type AgingOrder = { orderId: number; buyerId: number | null; paidDay: string; openCents: number; partial: boolean };
export type AgingGroup = { buyerId: number | null; orders: AgingOrder[]; totalCents: number; oldestDay: string };

/** Orders paid more than `days` ago that still have an open amount, grouped by buyer (oldest group first). */
export function agingByBuyer(orders: { orderId: number; buyerId: number | null; paidDay: string; paidCents: number; openCents: number }[], today: string, days = AGING_DAYS): AgingGroup[] {
  const groups = new Map<number | null, AgingGroup>();
  for (const o of orders) {
    if (o.openCents <= 0 || dayDiff(o.paidDay, today) <= days) continue;
    const g = groups.get(o.buyerId) ?? { buyerId: o.buyerId, orders: [], totalCents: 0, oldestDay: o.paidDay };
    g.orders.push({ orderId: o.orderId, buyerId: o.buyerId, paidDay: o.paidDay, openCents: o.openCents, partial: o.openCents < o.paidCents });
    g.totalCents += o.openCents;
    if (o.paidDay < g.oldestDay) g.oldestDay = o.paidDay;
    groups.set(o.buyerId, g);
  }
  for (const g of groups.values()) g.orders.sort((a, b) => a.paidDay.localeCompare(b.paidDay) || a.orderId - b.orderId);
  return [...groups.values()].sort((a, b) => a.oldestDay.localeCompare(b.oldestDay));
}

/** Days of margin: an order paid this long before the bank history starts can still have its deposit in the feed. */
export const PRE_FEED_DAYS = 30;

export function shiftDay(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** True when the order was paid more than PRE_FEED_DAYS before the first bank row, so its deposit predates the feed. No bank rows: false. */
export function isPreFeed(paidDay: string, feedStart: string | null): boolean {
  return feedStart != null && dayDiff(paidDay, feedStart) > PRE_FEED_DAYS;
}

/** The go-live check shows from PRE_FEED_DAYS before go-live onward; before that, only a note with this start date. */
export function goLiveCheckStart(goLive: string): string { return shiftDay(goLive, -PRE_FEED_DAYS); }
export function inGoLiveWindow(today: string, goLive: string): boolean { return today >= goLiveCheckStart(goLive); }

export type CheckOrder = { orderId: number; orderDay: string; paidDay: string; paidCents: number; preFeed: boolean };

/** Orders dated and paid before go-live, less deposits already linked on rows before go-live. Pre-feed orders are counted apart, not in the sum. */
export function goLiveCheckSum(orders: CheckOrder[], goLive: string, clearedEarly: Map<number, number>) {
  let ordersCents = 0, orderCount = 0, preFeedCents = 0, preFeedOrders = 0;
  for (const o of orders) {
    if (o.orderDay >= goLive || o.paidDay >= goLive) continue;
    const left = o.paidCents - (clearedEarly.get(o.orderId) ?? 0);
    if (left <= 0) continue;
    if (o.preFeed) { preFeedCents += left; preFeedOrders++; } else { ordersCents += left; orderCount++; }
  }
  return { ordersCents, orders: orderCount, preFeedCents, preFeedOrders };
}
