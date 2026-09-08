/**
 * Auto-sync staleness decision for BfmrReservationLinker.
 *
 * Opening an unlinked order used to fire a full external BFMR sync on EVERY
 * open, because the guard was a per-mount ref that reset each time the
 * component mounted. The real question is whether the local reservation data
 * is stale enough to be worth re-pulling from BFMR — and linked orders never
 * need it at all, since their data is already local.
 */

export function shouldAutoSync(opts: {
  lastSyncMs: number;   // max lastSyncedAt across loaded reservations, epoch ms; 0 if none
  now: number;          // Date.now()
  hasLinks: boolean;    // does this order already have BFMR links?
  thresholdMs?: number; // default 5 * 60_000
}): boolean {
  if (opts.hasLinks) return false;
  if (opts.lastSyncMs <= 0) return true;
  const threshold = opts.thresholdMs ?? 5 * 60_000;
  return opts.now - opts.lastSyncMs > threshold;
}

/**
 * Extract the expected item count from a scraped Amazon order's description.
 *
 * The Order model has no structured quantity column and there is no
 * order-items relation — the scrape (ImportRow in app/api/import/route.ts)
 * carries only `itemDescription` free text, so this is where "how many items
 * did we buy" lives when it lives anywhere. Returns null when no quantity is
 * discernible; callers must treat null as UNKNOWN and fall back to the plain
 * staleness gate — never as 0 (that would read "nothing expected" and block
 * every pull).
 */
export function parseExpectedItemCount(itemDescription: string | null | undefined): number | null {
  if (!itemDescription) return null;
  const d = itemDescription.trim();
  // "3 x Apple Watch Ultra 2" / "3xApple Watch" — leading quantity before the product name.
  let m = d.match(/^(\d+)\s*[x×]/i);
  if (m) return parseInt(m[1], 10);
  // "Qty: 3", "Quantity 2", "(qty 5)" anywhere in the description.
  m = d.match(/\b(?:qty|quantity)\s*[:=]?\s*(\d+)/i);
  if (m) return parseInt(m[1], 10);
  // "Apple Watch Ultra 2 — 3 units" / "1 unit".
  m = d.match(/(\d+)\s+units?/i);
  if (m) return parseInt(m[1], 10);
  return null;
}

/**
 * Fully accounted: the order's expected item count is known AND we already
 * hold at least that many units locally (linked reservations + reservations
 * held for this order). A fully-accounted order has nothing to gain from a
 * pull — and since BFMR's /my-tracker API offers no order-scoped filter, any
 * pull is the full-catalog one. So "accounted" must be a hard stop, not just
 * a hint.
 */
export function isFullyAccounted(opts: { expectedItemCount: number | null; accountedQty: number }): boolean {
  const expected = opts.expectedItemCount;
  return expected != null && expected > 0 && opts.accountedQty >= expected;
}

/**
 * Order-open auto-sync decision (Penn's rule):
 *   1. Linked / fully-accounted order -> pull NOTHING.
 *   2. Short on items (accounted < expected) -> pull to fill the gap, subject
 *      to the staleness throttle below.
 *   3. Expected count unknown -> plain staleness gate (legacy behavior).
 * The linked-skip and 5-minute throttle from shouldAutoSync are preserved;
 * this only adds the accounting stop on top of them.
 */
export function shouldAutoSyncForOrder(opts: {
  lastSyncMs: number;            // max lastSyncedAt across loaded reservations, epoch ms; 0 if none
  now: number;                   // Date.now()
  hasLinks: boolean;             // does this order already have BFMR links?
  thresholdMs?: number;          // default 5 * 60_000
  expectedItemCount?: number | null; // from the Amazon scrape (parseExpectedItemCount); null = unknown
  accountedQty?: number;         // units we already hold for this order (links + held reservations)
}): boolean {
  if (opts.hasLinks) return false;
  if (isFullyAccounted({ expectedItemCount: opts.expectedItemCount ?? null, accountedQty: opts.accountedQty ?? 0 })) {
    return false;
  }
  return shouldAutoSync(opts);
}
