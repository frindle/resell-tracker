// Pure helpers (no db import) so the books module and tests can use them.

export type LineKeyed = { bfmrLinkId: number | null; commitmentLinkId: number | null };

/** "bfmr:<id>" / "commit:<id>" / "order" — the ReturnableLine.key for a row. */
export function lineKeyOf(r: LineKeyed): string {
  return r.bfmrLinkId != null ? `bfmr:${r.bfmrLinkId}`
    : r.commitmentLinkId != null ? `commit:${r.commitmentLinkId}`
    : 'order';
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

