export type LinkableCommitment = { id: number; status: string; remaining: number; expiryDay: string | null };

// BG flips a commitment to "PARTIALLY FULFILLED" as soon as the first slot
// ships; the remaining slots are still linkable. Whitelist guards against
// future BG status values.
const OPEN_STATUSES = new Set(['ACTIVE', 'PARTIALLY FULFILLED']);

// Commitments an order can still be linked to: open, with slots remaining,
// not already linked to this order, and not expired. Expiry mirrors the
// commitments route's isShort rule: no/unparseable expiryDay = no expiry,
// otherwise linkable only while expiryDay is strictly after now. Input order
// is preserved and the input array is not mutated.
export function linkableCommitments<T extends LinkableCommitment>(commitments: T[], linkedHereIds: number[], nowMs: number): T[] {
  return commitments.filter(c => {
    if (!OPEN_STATUSES.has(c.status) || !(c.remaining > 0) || linkedHereIds.includes(c.id)) return false;
    const expiryMs = c.expiryDay ? Date.parse(c.expiryDay) : NaN;
    return Number.isNaN(expiryMs) || expiryMs > nowMs;
  });
}
