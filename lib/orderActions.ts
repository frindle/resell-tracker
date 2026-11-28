// Orders that need a person: the "needs your action" section of the daily digest (lib/digestLines.ts).
//
// Pure. lib/digestRunner.ts loads the orders, the carrier-delivery summaries and the unresolved payout shortfalls;
// this file only decides which group each order falls in and why. Every signal is one the app already has:
// the /orders Partial and Overdue filters (lib/paymentStatus.ts), the buyer-mismatch flag, the Books Shortfalls
// tab, the delivery-vs-received flag, the periodic tracking sweep (lib/autoSubmitSweepPlan.ts), /orders/blocked is left out on purpose (below),
// the below-cost alert, BFMR rejected items and the stale-return nag of lib/deadlineReminders.ts.
//
// Each order lands in one group, the most serious it qualifies for, under its first matching reason.

import { PROCESSED_STATUSES } from './paymentStatus.ts';
import { sweepCandidateIds, type SweepOrder } from './autoSubmitSweepPlan.ts';
import { LATE_RECEIPT_DAYS } from './deliveryVsReceived.ts';

export type ActionGroup = 'dispute' | 'manual' | 'review';
export const ACTION_GROUPS: readonly ActionGroup[] = ['dispute', 'manual', 'review'];

export type ActionCode =
  | 'paid_below_expected' | 'buyer_mismatch' | 'deposit_short' | 'overdue' | 'delivered_not_credited'
  | 'tracking_not_uploaded' | 'delivery_exception' | 'no_buyer'
  | 'below_cost' | 'rejected_items' | 'stale_return';

/** Paid this far under the expected payout (dollars) is a dispute; less is rounding. */
export const SHORT_TOLERANCE = 0.05;
/** A delivered order the group has not received or credited for this long is chased. */
export const DELIVERED_NOT_CREDITED_DAYS = 7;
/** A tracking number the sweep still has not uploaded this long after the order date has been stuck, not just slow. */
export const TRACKING_STUCK_DAYS = 3;
/** Orders older than this are history, not a to-do. */
export const ACTION_WINDOW_DAYS = 120;

export type ActionDelivery = {
  state: 'delivered' | 'partial' | 'in_transit' | 'exception' | 'unknown';
  daysSinceDelivered: number | null;
  lateReceipt: boolean;
};

export type ActionOrder = {
  id: number;
  orderNumber: string | null;
  platform: string;
  buyerId: number | null;
  buyerName: string | null;
  orderDate: Date;
  cost: number;
  salePrice: number | null;
  salePriceSynced: boolean;
  bgExpectedPayout: number | null;
  bgPaidAmount: number | null;
  bgPaidAt: Date | null;
  bgCredited: boolean;
  bfmrStatus: string | null;
  buyerMismatch: boolean;
  overdueAt: Date | null;
  lost: boolean;
  locked: boolean;
  cancelled: boolean;
  trackingNumbers: string | null;
  trackingSubmittedToBg: boolean;
  blockedAddressPattern: string | null;
  ignoredByRule?: boolean;
  belowCostAlert: string | null;
  bfmrRejectedItems: string | null;
  /** A return opened more than lib/deadlineReminders.ts's STALE_RETURN_DAYS ago that never reached a terminal state. */
  staleOpenReturn: boolean;
  delivery?: ActionDelivery | null;
};

/** Unresolved payout shortfall per order, in cents: a deposit that came in under what the order was owed. */
export type ShortfallByOrder = ReadonlyMap<number, number>;

export type ActionItem = {
  orderId: number;
  orderNumber: string | null;
  platform: string;
  group: string | null;
  /** Money at stake, dollars. */
  amount: number;
  ageDays: number;
  code: ActionCode;
  reason: string;
  action: string;
};

export type ActionGroups = Record<ActionGroup, ActionItem[]>;

const DAY_MS = 86400000;

function ageOf(since: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - since.getTime()) / DAY_MS));
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function hasTracking(o: ActionOrder): boolean {
  return !!o.trackingNumbers && o.trackingNumbers.split(',').some(t => t.trim());
}

/** Same day-granularity rule as lib/overdue.ts, against `now` (a payment due today is not yet overdue). */
function pastDue(due: Date, now: Date): boolean {
  const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return day(now) > day(due);
}

function hasRejectedItems(raw: string | null): boolean {
  if (!raw) return false;
  try { const v = JSON.parse(raw); return Array.isArray(v) && v.length > 0; } catch { return false; }
}

function expectedPayout(o: ActionOrder): number | null {
  return o.bgExpectedPayout ?? o.salePrice;
}

/** How far under the expected payout the group paid, in dollars (0 when it paid in full or nothing yet). Not for a synced sale price, as on /orders. */
export function paidShortBy(o: Pick<ActionOrder, 'bgPaidAmount' | 'bgExpectedPayout' | 'salePrice' | 'salePriceSynced'>): number {
  if (o.salePriceSynced || o.bgPaidAmount == null || o.bgPaidAmount <= 0) return 0;
  const expected = o.bgExpectedPayout ?? o.salePrice;
  if (expected == null) return 0;
  const short = expected - o.bgPaidAmount;
  return short > SHORT_TOLERANCE ? round2(short) : 0;
}

type Candidate = { group: ActionGroup; code: ActionCode; amount: number; since: Date; reason: string; action: string };

/** The groups' action items for `orders` (any order, cancelled or not). Each order appears once, biggest money first. */
export function classifyActionOrders(orders: readonly ActionOrder[], shortfalls: ShortfallByOrder, now: Date): ActionGroups {
  const out: ActionGroups = { dispute: [], manual: [], review: [] };
  const sweepIds = new Set(sweepCandidateIds(orders.map((o): SweepOrder => ({
    id: o.id, orderDate: o.orderDate, trackingNumbers: o.trackingNumbers, trackingSubmittedToBg: o.trackingSubmittedToBg,
    cancelled: o.cancelled, locked: o.locked, buyerName: o.buyerName,
  })), now.getTime()));
  const windowStart = now.getTime() - ACTION_WINDOW_DAYS * DAY_MS;

  for (const o of orders) {
    // Orders held at import (blocked address) or ignored by a rule are personal or Darkbloom purchases shipped home
    // on purpose, not work to do.
    if (o.cancelled || o.ignoredByRule || o.blockedAddressPattern) continue;
    const owed = o.salePrice ?? expectedPayout(o) ?? 0;
    const short = paidShortBy(o);
    const paidInFull = o.salePriceSynced || (o.bgPaidAmount != null && o.bgPaidAmount > 0 && short === 0);
    const credited = o.bgCredited || (!!o.bfmrStatus && PROCESSED_STATUSES.has(o.bfmrStatus.toLowerCase()));
    const cands: Candidate[] = [];
    const add = (c: Candidate) => { cands.push(c); };

    // Dispute with the group.
    const shortCents = shortfalls.get(o.id) ?? 0;
    if (o.buyerMismatch && !o.lost) add({ group: 'dispute', code: 'buyer_mismatch', amount: owed, since: o.bgPaidAt ?? o.orderDate, reason: 'paid by a different group than assigned', action: 'confirm which group owes this order' });
    if (shortCents > 0) add({ group: 'dispute', code: 'deposit_short', amount: round2(shortCents / 100), since: o.bgPaidAt ?? o.orderDate, reason: 'deposit came in short of the payout', action: 'ask the group where the rest is' });
    if (!o.lost && !paidInFull && !credited && o.overdueAt && pastDue(o.overdueAt, now) && (o.buyerId != null || o.buyerName)) {
      add({ group: 'dispute', code: 'overdue', amount: owed, since: o.overdueAt, reason: 'payment is past its due date', action: 'ask the group for the payment' });
    }
    const d = o.delivery;
    if (!o.lost && !paidInFull && !credited && d && d.state === 'delivered' && d.lateReceipt && (d.daysSinceDelivered ?? 0) >= Math.max(LATE_RECEIPT_DAYS, DELIVERED_NOT_CREDITED_DAYS)) {
      add({ group: 'dispute', code: 'delivered_not_credited', amount: owed, since: new Date(now.getTime() - (d.daysSinceDelivered ?? 0) * DAY_MS), reason: 'delivered but the group has not received or credited it', action: 'send the group the delivery proof' });
    }

    // Manual handling.
    if (sweepIds.has(o.id) && !paidInFull && !credited && ageOf(o.orderDate, now) >= TRACKING_STUCK_DAYS) {
      add({ group: 'manual', code: 'tracking_not_uploaded', amount: owed, since: o.orderDate, reason: 'tracking was not uploaded to the group', action: 'submit the tracking by hand' });
    }
    if (!o.lost && !paidInFull && d && d.state === 'exception') add({ group: 'manual', code: 'delivery_exception', amount: owed, since: o.orderDate, reason: 'the carrier reports a delivery problem', action: 'check the carrier and mark it lost or delivered' });
    if (!o.lost && o.buyerId == null && !o.salePriceSynced && hasTracking(o)) add({ group: 'manual', code: 'no_buyer', amount: owed || o.cost, since: o.orderDate, reason: 'shipped with no group assigned', action: 'pick the group' });

    // Review.
    // TODO: switch to the bgShortPaid / over-linked-commitment helper once branch bg-short-paid-final merges: the
    // expected payout is overstated when a commitment is linked for more units than it holds, so this is not yet a dispute.
    if (short > 0) add({ group: 'review', code: 'paid_below_expected', amount: short, since: o.bgPaidAt ?? o.orderDate, reason: 'paid below the expected payout', action: 'check the payout against the group' });
    if (o.belowCostAlert) add({ group: 'review', code: 'below_cost', amount: o.cost, since: o.orderDate, reason: 'sale price fell below cost', action: 'check the new price' });
    if (hasRejectedItems(o.bfmrRejectedItems)) add({ group: 'review', code: 'rejected_items', amount: owed || o.cost, since: o.orderDate, reason: 'the group rejected items', action: 'check the rejection' });
    if (o.staleOpenReturn) add({ group: 'review', code: 'stale_return', amount: o.cost, since: o.orderDate, reason: 'a return is open with no refund', action: 'chase the refund' });

    if (cands.length === 0) continue;
    // Old paid-and-forgotten history is not a to-do, except money still short.
    if (o.orderDate.getTime() < windowStart && !cands.some(c => c.code === 'paid_below_expected' || c.code === 'deposit_short')) continue;
    const best = cands.sort((a, b) => ACTION_GROUPS.indexOf(a.group) - ACTION_GROUPS.indexOf(b.group))[0];
    out[best.group].push({
      orderId: o.id, orderNumber: o.orderNumber, platform: o.platform, group: o.buyerName,
      amount: round2(best.amount), ageDays: ageOf(best.since, now), code: best.code, reason: best.reason, action: best.action,
    });
  }
  for (const g of ACTION_GROUPS) out[g].sort((a, b) => b.amount - a.amount || b.ageDays - a.ageDays || a.orderId - b.orderId);
  return out;
}

export function actionTotal(g: ActionGroups): number {
  return ACTION_GROUPS.reduce((s, k) => s + g[k].length, 0);
}
