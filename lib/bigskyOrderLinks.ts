// Rules for setting an order aside for BigSky commitments, kept pure so they
// can be tested without a database.

export type OfferInput = { id: number; open: number; expired: boolean };

/**
 * Units of a commitment still free for THIS order. `othersPlanned` is what
 * OTHER live orders have set aside; the caller leaves out this order's own
 * link, cancelled orders and orders already filled by scans. Nothing is
 * subtracted here, so a unit is never taken off that was never counted.
 */
export function unitsFreeForOrder(c: { open: number; othersPlanned: number }): number {
  return Math.max(0, c.open - Math.max(0, c.othersPlanned));
}

/**
 * Whether a requested quantity must be refused for lack of room. Keeping or
 * lowering a link the order already holds never takes a unit from anyone, so
 * it passes even when the commitment is over-committed. `ownQuantity` is the
 * quantity this order already has on the target commitment (null if none).
 */
export function exceedsCapacity(quantity: number, free: number, ownQuantity: number | null): boolean {
  if (ownQuantity != null && quantity <= ownQuantity) return false;
  return quantity > free;
}

/**
 * Commitments to offer on an order: not expired, not already filled by this
 * order's own scans, and with room left once this order's own link is not
 * counted against them. `othersPlanned` maps commitment id to the units other
 * orders hold; `ownQuantity` maps it to the quantity this order already has
 * linked there.
 */
export function offerableCommitments<T extends OfferInput>(
  commitments: T[],
  othersPlanned: ReadonlyMap<number, number>,
  ownQuantity: ReadonlyMap<number, number>,
  filledHere: ReadonlySet<number>,
): Array<T & { free: number; linkedQuantity: number }> {
  const out: Array<T & { free: number; linkedQuantity: number }> = [];
  for (const c of commitments) {
    if (c.expired || filledHere.has(c.id)) continue;
    const linkedQuantity = ownQuantity.get(c.id) ?? 0;
    const free = unitsFreeForOrder({ open: c.open, othersPlanned: othersPlanned.get(c.id) ?? 0 });
    if (free > 0) out.push({ ...c, free, linkedQuantity });
  }
  return out;
}

export type LinkChangePlan =
  | { ok: true; deleteLinkId: number | null }
  | { ok: false; error: string };

/**
 * Moving an order's link to another commitment in one step. `replaceLinkId`
 * is the link being replaced (null for a plain link). The old link goes away
 * once the new one is saved; linking to the commitment it already has just
 * changes the quantity.
 */
export function planLinkChange(
  ownLinks: ReadonlyArray<{ id: number; commitmentId: number }>,
  targetCommitmentId: number,
  replaceLinkId: number | null,
): LinkChangePlan {
  if (replaceLinkId == null) return { ok: true, deleteLinkId: null };
  const old = ownLinks.find(l => l.id === replaceLinkId);
  if (!old) return { ok: false, error: 'link to replace not found on this order' };
  if (old.commitmentId === targetCommitmentId) return { ok: true, deleteLinkId: null };
  if (ownLinks.some(l => l.commitmentId === targetCommitmentId)) {
    return { ok: false, error: 'this order is already linked to that commitment' };
  }
  return { ok: true, deleteLinkId: old.id };
}
