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
