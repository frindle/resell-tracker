export type LinkableCommitment = { id: number; status: string; remaining: number; expiryDay: string | null };

// BG flips a commitment to "PARTIALLY FULFILLED" as soon as the first slot
// ships; the remaining slots are still linkable. Whitelist guards against
// future BG status values.
const OPEN_STATUSES = new Set(['ACTIVE', 'PARTIALLY FULFILLED']);

// BG's expiryDay is a calendar day, stored as midnight UTC of that date. The
// commitment is open through the whole of that day, so it is expired only once
// the current Pacific-time date is AFTER it. Comparing instants instead hid a
// commitment from ~5pm Pacific the evening BEFORE its expiry day.
// No/unparseable expiryDay = no expiry.
export function isExpiryDayPast(expiryDay: string | Date | null | undefined, nowMs: number): boolean {
  if (!expiryDay) return false;
  const ms = typeof expiryDay === 'string' ? Date.parse(expiryDay) : expiryDay.getTime();
  if (Number.isNaN(ms)) return false;
  const expiryDate = new Date(ms).toISOString().slice(0, 10);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(nowMs));
  return today > expiryDate;
}

// Commitments an order can still be linked to: open, with slots remaining,
// not already linked to this order, and not past their expiry day. Input order
// is preserved and the input array is not mutated.
export function linkableCommitments<T extends LinkableCommitment>(commitments: T[], linkedHereIds: number[], nowMs: number): T[] {
  return commitments.filter(c =>
    OPEN_STATUSES.has(c.status) && c.remaining > 0 && !linkedHereIds.includes(c.id) && !isExpiryDayPast(c.expiryDay, nowMs)
  );
}
