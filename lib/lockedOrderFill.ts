// What a routine sync may still write to a LOCKED order. The lock stops syncs
// overwriting confirmed values; it must not stop a missing payment landing.
// Orders 900/906 were locked by the pre-6ed70d7 partial-paid bug, their
// bgPaidAmount later cleared, and every sync since skipped them -- fully paid
// on BFMR, never marked paid here.
//
// Only fills: bgPaidAmount when empty, bfmrReceived false -> true, bfmrStatus
// when it moves FORWARD, and clearing overdueAt once paid/received.
export function lockedOrderFill(
  order: { bgPaidAmount: number | null; bfmrReceived: boolean | null; bfmrStatus: string | null; overdueAt: Date | null },
  patch: Record<string, unknown>,
  rank: (status: string | null | undefined) => number,
): Record<string, unknown> {
  const fill: Record<string, unknown> = {};
  if (order.bgPaidAmount == null && typeof patch.bgPaidAmount === 'number' && patch.bgPaidAmount > 0) fill.bgPaidAmount = patch.bgPaidAmount;
  if (!order.bfmrReceived && patch.bfmrReceived === true) fill.bfmrReceived = true;
  if (typeof patch.bfmrStatus === 'string' && rank(patch.bfmrStatus) > rank(order.bfmrStatus)) fill.bfmrStatus = patch.bfmrStatus;
  if (order.overdueAt && 'overdueAt' in patch && patch.overdueAt === null) fill.overdueAt = null;
  return fill;
}
