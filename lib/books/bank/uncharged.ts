// Orders whose card charge never showed up in the bank feed, or showed up short. Pure: no database.
import { CHARGE_MAX_DAYS, dayDiff, expectedChargeCents, type MatchOrder } from '../match.ts';

/** Days a card charge can take to post after the matcher's window closes; an order is only judged past both. */
export const POSTING_LAG_DAYS = 3;
/** A charge this much (cents) under the expected amount, or less, is not called short. */
export const SHORT_TOLERANCE_CENTS = 100;

export type UnchargedOrder = {
  orderId: number; orderNumber: string | null; orderDate: string; cardId: number; item: string | null;
  expectedCents: number; chargedCents: number; status: 'none' | 'short';
};

export type UnchargedInput = MatchOrder & { item: string | null };

/**
 * Which orders to list. `feedStart` maps a card id to the earliest posted date across the feed accounts linked to that
 * card; a card absent from it is unlinked (or has no data) and its orders are left out, counted in `unlinked` (linked
 * cards only count when the account has no rows at all). `charged` is the order_charge link sum per order, in cents.
 */
export function findUncharged(
  orders: UnchargedInput[], charged: Map<number, number>, feedStart: Map<number, string | null>, goLive: string, today: string,
): { rows: UnchargedOrder[]; unlinked: number } {
  const rows: UnchargedOrder[] = [];
  let unlinked = 0;
  for (const o of orders) {
    if (o.cancelled || o.cardId == null || o.orderDate < goLive) continue;
    if (!feedStart.has(o.cardId)) { unlinked++; continue; }
    const start = feedStart.get(o.cardId);
    if (!start || o.orderDate < start) continue; // the feed does not reach back this far: no data is not a miss
    if (dayDiff(o.orderDate, today) <= CHARGE_MAX_DAYS + POSTING_LAG_DAYS) continue; // still inside the window
    const expectedCents = expectedChargeCents(o).min;
    if (expectedCents <= 0) continue;
    const chargedCents = charged.get(o.id) ?? 0;
    if (chargedCents > 0 && chargedCents >= expectedCents - SHORT_TOLERANCE_CENTS) continue;
    rows.push({
      orderId: o.id, orderNumber: o.orderNumber, orderDate: o.orderDate, cardId: o.cardId, item: o.item,
      expectedCents, chargedCents, status: chargedCents === 0 ? 'none' : 'short',
    });
  }
  rows.sort((a, b) => a.orderDate.localeCompare(b.orderDate) || a.orderId - b.orderId);
  return { rows, unlinked };
}
