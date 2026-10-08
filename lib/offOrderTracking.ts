// Drop BFMR lines (tracker items / reservation links) whose tracking number is
// not on the local order, when at least one line does match the order's
// tracking. Pure, so it is unit tested.
//
// Order 943: one Amazon order (3 units, $297) carries two BFMR trackers under
// the same order number -- one paid on the order's real tracking, one stuck at
// "shipped" on a tracking the order never had (an old label). Summing both
// doubled the payout to $594, and every save/sync re-derived it over the
// user's override. The order's own tracking list is the record of what
// shipped, so a line on a foreign tracking is not this order's money.
//
// Never empties: if no line matches (order tracking not scraped yet, or BFMR
// has a different number for everything), every line is kept. Lines with no
// tracking are kept -- lib/bfmrLinkReconcile.ts handles those.
const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, '').toLowerCase();

export function dropOffOrderTracking<T>(
  lines: T[],
  orderTrackingNumbers: string | null | undefined,
  trackingOf: (l: T) => string | null | undefined,
): T[] {
  const onOrder = new Set((orderTrackingNumbers ?? '').split(',').map(norm).filter(Boolean));
  if (onOrder.size === 0) return lines;
  const matches = (l: T) => onOrder.has(norm(trackingOf(l)));
  if (!lines.some(matches)) return lines;
  return lines.filter(l => !norm(trackingOf(l)) || matches(l));
}
