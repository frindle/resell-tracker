// Which existing orders "Apply Rules to Existing" quarantines, and the
// pattern each one is recorded under. Every flagged order gets a pattern so
// it shows on /orders/blocked, where it can be reviewed and allowed back.

export type ApplyCandidate = { id: number; platform: string; shippingAddress: string | null; buyerId: number | null };

/** Pattern -> ids of the orders to quarantine under it. */
export function planBlockedApply(
  orders: readonly ApplyCandidate[],
  patterns: readonly string[],
  pickupPlatforms: readonly string[],
  pickupPattern: string,
): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const add = (p: string, id: number) => out.set(p, [...(out.get(p) ?? []), id]);
  for (const o of orders) {
    const addr = (o.shippingAddress ?? '').toLowerCase();
    // Same match as the import route: first pattern contained in the address.
    const hit = addr ? patterns.find(p => p.trim() && addr.includes(p.toLowerCase())) : undefined;
    if (hit) add(hit, o.id);
    else if (!addr && o.buyerId == null && pickupPlatforms.includes(o.platform)) add(pickupPattern, o.id);
  }
  return out;
}
