// Return status vocabulary + pure predicates over OrderReturn rows.
// Split out of lib/orderReturns.ts (which imports prisma) so client
// components can share the same definitions instead of duplicating them.

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

/** Still in flight — the order needs attention. Excludes both terminal states. */
export const OPEN_RETURN_STATUSES: readonly string[] = ['requested', 'in_transit', 'received'];

export function hasOpenReturns(returns: Array<{ status: string }>): boolean {
  return returns.some(r => OPEN_RETURN_STATUSES.includes(r.status));
}

/**
 * Every unit on the order has come back, so there is nothing left to be paid
 * for. Payout checks (BG discrepancy, outstanding, overdue) have to skip these
 * — salePrice is recomputed down to ~0 while bgExpectedPayout still holds the
 * original figure, which otherwise reads as a short-pay.
 *
 * `lineQuantities` is the live link-row quantities; empty means an unlinked
 * order, whose synthetic whole-order line is 1 unit (see getReturnableLines).
 */
export function isFullyReturned(
  returns: Array<{ quantity: number }>,
  lineQuantities: number[],
): boolean {
  if (returns.length === 0) return false;
  const total = lineQuantities.length ? lineQuantities.reduce((a, b) => a + b, 0) : 1;
  return returns.reduce((s, r) => s + r.quantity, 0) >= total;
}
