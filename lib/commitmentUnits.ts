// How many units of a BuyingGroup commitment its order links can really count. A commitment holds `count` units;
// order links are quantities against it. When the links add up to more than the commitment holds (an over-link), the
// extra units were never committed and BG does not pay the commitment price for them, so an order's expected payout
// must not count them. Pure, no I/O; lib/commitmentUnitsDb.ts loads the rows.
//
// Links claim a commitment's units in link id order: the first links get theirs, a later one only what is left.

export type LinkUnits = { id: number; orderId: number; commitmentId: number; quantity: number };

/** Units each link may count, by link id: min(quantity, units left after earlier links on the same commitment). */
export function countedByLink(links: readonly LinkUnits[], counts: ReadonlyMap<number, number>): Map<number, number> {
  const used = new Map<number, number>();
  const out = new Map<number, number>();
  for (const l of [...links].sort((a, b) => a.id - b.id)) {
    const cap = counts.get(l.commitmentId);
    const before = used.get(l.commitmentId) ?? 0;
    const counted = cap == null ? l.quantity : Math.max(0, Math.min(l.quantity, cap - before));
    out.set(l.id, counted);
    used.set(l.commitmentId, before + l.quantity);
  }
  return out;
}

/** Commitments whose links add up to more units than they hold. */
export function overLinkedCommitments(links: readonly LinkUnits[], counts: ReadonlyMap<number, number>): { commitmentId: number; count: number; linked: number }[] {
  const sums = new Map<number, number>();
  for (const l of links) sums.set(l.commitmentId, (sums.get(l.commitmentId) ?? 0) + l.quantity);
  return [...sums].filter(([id, linked]) => counts.has(id) && linked > counts.get(id)!).map(([commitmentId, linked]) => ({ commitmentId, count: counts.get(commitmentId)!, linked })).sort((a, b) => a.commitmentId - b.commitmentId);
}

/** For one order: units linked vs units its links can count, or null when they agree. "9 units, 8 committed". */
export function orderOverLink(orderId: number, links: readonly LinkUnits[], counts: ReadonlyMap<number, number>): { linked: number; committed: number } | null {
  const counted = countedByLink(links, counts);
  const mine = links.filter(l => l.orderId === orderId);
  const linked = mine.reduce((s, l) => s + l.quantity, 0);
  const committed = mine.reduce((s, l) => s + (counted.get(l.id) ?? l.quantity), 0);
  return committed < linked ? { linked, committed } : null;
}
