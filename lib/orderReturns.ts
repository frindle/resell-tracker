import { prisma } from '@/lib/db';

// Partial returns, quantity-aware.
//
// The problem this solves: an order's units live in link tables
// (OrderBfmrLink / OrderCommitmentLink), each carrying a `quantity`. Sale
// price is derived from those quantities. Before this, a return was a single
// order-level `returnStatus` string, so "1 of the 3 units on this line came
// back" had nowhere to live — the order kept showing all 3 units as sold and
// the full purchase price as cost basis (order 832: $854 / 3 units, 1
// returned, still reading as 3 sold).
//
// Every OrderReturn row removes its `quantity` units from the sold count of
// its line, in EVERY status. That's deliberate: `rejected` (group refused it,
// it's shipping back to us) is just as much "not a completed sale" as
// `refunded` is. Only the money side differs — see returnedCostFor().

export const RETURN_STATUSES = ['requested', 'in_transit', 'received', 'refunded', 'rejected'] as const;
export type ReturnStatus = typeof RETURN_STATUSES[number];

export const RETURN_STATUS_LABELS: Record<ReturnStatus, string> = {
  requested: 'Return requested',
  in_transit: 'In transit back',
  received: 'Received — refund pending',
  refunded: 'Refunded',
  rejected: 'Rejected by group (in transit back)',
};

export function isReturnStatus(s: string): s is ReturnStatus {
  return (RETURN_STATUSES as readonly string[]).includes(s);
}

/**
 * Payout for the units of a link that are still sold.
 *
 * `value` on an OrderBfmrLink is the ABSOLUTE total for the whole link (the
 * linker prefills it with the raw reservation.totalPayout), NOT a per-unit
 * rate — so a partial return has to take a proportional slice of it rather
 * than multiplying it by the remaining count.
 */
export function proratedLinkValue(value: number, lineQty: number, soldQty: number): number {
  if (soldQty <= 0) return 0;
  if (lineQty <= 0) return value;
  return (value * soldQty) / lineQty;
}

/**
 * Cost basis written off by a set of returns.
 *
 * A refunded return writes off exactly what came back. Anything still in
 * flight writes off the order's per-unit cost, so the remaining units carry
 * the remaining cost. `rejected` writes off nothing: the group sent it back
 * but no retailer refund has been opened, so that money is still spent.
 */
export function returnedCostFor(
  returns: Array<{ status: string; quantity: number; refundAmount: number | null }>,
  perUnitCost: number,
): number {
  const total = returns.reduce((sum, r) => {
    if (r.status === 'rejected') return sum;
    if (r.refundAmount != null) return sum + r.refundAmount;
    return sum + perUnitCost * r.quantity;
  }, 0);
  return Math.round(total * 100) / 100;
}

/**
 * Drop return units that no line covers any more.
 *
 * Returns outlive their line: deleting an OrderBfmrLink orphans its rows (no
 * FK, the link tables only cascade from Order), and PATCHing a link's quantity
 * down leaves more units returned than the line now has. The cost denominator
 * in recalcReturnedCost is the sum of LIVE line quantities, so counting those
 * units writes off cost the order never had — a 3-unit link cut to 1 with 2
 * units returned charged 2 x the FULL order cost, driving the basis negative.
 *
 * Each line pays for at most its own current quantity, oldest return first.
 */
export function clampReturnsToLines<T extends LineKeyed & { quantity: number }>(
  returns: T[],
  lines: Array<{ key: string; quantity: number }>,
): T[] {
  const allowance = new Map(lines.map(l => [l.key, l.quantity]));
  return returns.map(r => {
    const key = lineKeyOf(r);
    const left = allowance.get(key) ?? 0;
    const quantity = Math.min(r.quantity, left);
    allowance.set(key, left - quantity);
    return { ...r, quantity };
  }).filter(r => r.quantity > 0);
}

/** A returnable line: one row of one of the link tables, or the order itself. */
export type ReturnableLine = {
  key: string;                    // stable id for the UI: "bfmr:12" | "commit:3" | "order"
  bfmrLinkId: number | null;
  commitmentLinkId: number | null;
  itemName: string;
  trackingNumber: string | null;
  quantity: number;               // units on the line
  returnedQuantity: number;       // units already covered by OrderReturn rows
};

type LineKeyed = { bfmrLinkId: number | null; commitmentLinkId: number | null };

function sameLine(a: LineKeyed, b: LineKeyed) {
  return a.bfmrLinkId === b.bfmrLinkId && a.commitmentLinkId === b.commitmentLinkId;
}

/** "bfmr:<id>" / "commit:<id>" / "order" — the ReturnableLine.key for a row. */
export function lineKeyOf(r: LineKeyed): string {
  return r.bfmrLinkId != null ? `bfmr:${r.bfmrLinkId}`
    : r.commitmentLinkId != null ? `commit:${r.commitmentLinkId}`
    : 'order';
}

/**
 * Every line on the order the user can return units from, with how many units
 * are already spoken for. Orders with no group links at all still get a single
 * synthetic "whole order" line so a plain retail return is recordable.
 */
export async function getReturnableLines(orderId: number): Promise<ReturnableLine[]> {
  const [bfmrLinks, commitmentLinks, returns, order] = await Promise.all([
    prisma.orderBfmrLink.findMany({
      where: { orderId },
      select: {
        id: true, quantity: true, trackingNumber: true,
        reservation: { select: { itemName: true, dealTitle: true } },
      },
      orderBy: { id: 'asc' },
    }),
    prisma.orderCommitmentLink.findMany({
      where: { orderId },
      select: { id: true, quantity: true, commitment: { select: { dealTitle: true } } },
      orderBy: { id: 'asc' },
    }),
    prisma.orderReturn.findMany({
      where: { orderId },
      select: { bfmrLinkId: true, commitmentLinkId: true, quantity: true },
    }),
    prisma.order.findUnique({
      where: { id: orderId },
      select: { itemDescription: true, trackingNumbers: true },
    }),
  ]);

  const returnedFor = (line: LineKeyed) =>
    returns.filter(r => sameLine(r, line)).reduce((s, r) => s + r.quantity, 0);

  const lines: ReturnableLine[] = [
    ...bfmrLinks.map(l => {
      const key = { bfmrLinkId: l.id, commitmentLinkId: null };
      return {
        key: `bfmr:${l.id}`,
        ...key,
        itemName: l.reservation.itemName || l.reservation.dealTitle || `Reservation link #${l.id}`,
        trackingNumber: l.trackingNumber,
        quantity: l.quantity,
        returnedQuantity: returnedFor(key),
      };
    }),
    ...commitmentLinks.map(l => {
      const key = { bfmrLinkId: null, commitmentLinkId: l.id };
      return {
        key: `commit:${l.id}`,
        ...key,
        itemName: l.commitment.dealTitle || `Commitment link #${l.id}`,
        trackingNumber: null,
        quantity: l.quantity,
        returnedQuantity: returnedFor(key),
      };
    }),
  ];

  if (lines.length === 0) {
    const key = { bfmrLinkId: null, commitmentLinkId: null };
    lines.push({
      key: 'order',
      ...key,
      itemName: order?.itemDescription || `Order #${orderId}`,
      trackingNumber: (order?.trackingNumbers ?? '').split(',')[0]?.trim() || null,
      // No line data to go on — one unit, unless returns already exceed that.
      quantity: Math.max(1, returnedFor(key)),
      returnedQuantity: returnedFor(key),
    });
  }
  return lines;
}

/** Units returned per line, keyed as "bfmr:<id>" / "commit:<id>" / "order". */
export async function returnedUnitsByLine(orderId: number): Promise<Map<string, number>> {
  const returns = await prisma.orderReturn.findMany({
    where: { orderId },
    select: { bfmrLinkId: true, commitmentLinkId: true, quantity: true },
  });
  const m = new Map<string, number>();
  for (const r of returns) {
    const key = lineKeyOf(r);
    m.set(key, (m.get(key) ?? 0) + r.quantity);
  }
  return m;
}

/**
 * Cost basis removed from the order by its returns.
 *
 * Per unit: the real refund when one has posted, otherwise the order's own
 * per-unit cost (total spend / total units), so a return that's still in
 * flight already stops the returned units from inflating the cost basis —
 * that's what "purchase price should correspond to the 2-remaining-of-3
 * reality" means. `rejected` units are the exception: the group sent them
 * back, but no retailer return has been opened, so the money genuinely is
 * still out the door and they keep their full cost.
 */
export async function recalcReturnedCost(orderId: number): Promise<number> {
  const [order, returns, lines] = await Promise.all([
    prisma.order.findUnique({
      where: { id: orderId },
      select: { cost: true, shippingCost: true, insuranceCost: true, locked: true },
    }),
    prisma.orderReturn.findMany({ where: { orderId }, orderBy: { id: 'asc' } }),
    getReturnableLines(orderId),
  ]);
  if (!order) return 0;

  const totalUnits = Math.max(1, lines.reduce((s, l) => s + l.quantity, 0));
  const perUnitCost = (order.cost + order.shippingCost + order.insuranceCost) / totalUnits;

  const rounded = returnedCostFor(clampReturnsToLines(returns, lines), perUnitCost);
  await prisma.order.updateMany({
    where: { id: orderId, locked: false },
    data: { returnedCost: rounded },
  });
  return rounded;
}

/**
 * Full recompute after any change to an order's returns: cost basis, then the
 * group sale price (which nets out returned units per link).
 */
export async function recalcAfterReturnChange(orderId: number) {
  const returnedCost = await recalcReturnedCost(orderId);
  // Imported lazily: both sale-price modules import prisma and each other's
  // sibling helpers; a static import here would make lib/orderReturns a
  // dependency of them in turn.
  const [{ recalcBfmrSalePrice }, { recalcSalePrice }] = await Promise.all([
    import('@/lib/bfmrSalePrice'),
    import('@/lib/commitmentSalePrice'),
  ]);
  const [bfmrCount, commitCount] = await Promise.all([
    prisma.orderBfmrLink.count({ where: { orderId } }),
    prisma.orderCommitmentLink.count({ where: { orderId } }),
  ]);
  if (bfmrCount > 0) await recalcBfmrSalePrice(orderId);
  if (commitCount > 0) await recalcSalePrice(orderId);
  return returnedCost;
}

/**
 * Amazon's order-detail / "return & refund status" pages state a return in
 * plain English: "Return started", "Return requested for 1 of 3 items",
 * "Refund issued", "Return requested on: Aug 3, 2026".
 *
 * This maps that text onto (status, quantity, of) so the sidecar scraper can
 * feed OrderReturn rows later. DESIGNED FOR, NOT YET WIRED — nothing calls
 * this in production yet; it exists so adding the scrape is a caller change,
 * not a schema change. Self-check lives in the demo block at the bottom.
 */
export function mapAmazonReturnStatus(text: string): {
  status: ReturnStatus | null;
  quantity: number | null;
  of: number | null;
} {
  const t = text.toLowerCase();
  // "for 1 of 3 items" — Amazon is quantity-aware too, which is exactly the
  // granularity the OrderReturn rows need.
  const qty = /\b(\d+)\s+of\s+(\d+)\b/.exec(t);
  const quantity = qty ? parseInt(qty[1], 10) : null;
  const of = qty ? parseInt(qty[2], 10) : null;

  // Order matters: the more specific/terminal phrasings win over the generic
  // "return started"/"return requested" that Amazon keeps showing alongside.
  let status: ReturnStatus | null = null;
  if (/refund (issued|completed|processed)|refunded/.test(t)) status = 'refunded';
  else if (/(return|item)\s+(was\s+)?(rejected|denied|not eligible|declined)/.test(t)) status = 'rejected';
  else if (/(return )?received|delivered to (the )?(seller|amazon)|item received/.test(t)) status = 'received';
  else if (/in transit|on (its|the) way|shipped|picked up|dropped off/.test(t)) status = 'in_transit';
  else if (/return (started|requested|initiated)|return label/.test(t)) status = 'requested';

  return { status, quantity, of };
}
