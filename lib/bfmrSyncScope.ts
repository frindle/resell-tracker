export type BfmrSyncScope = 'all' | 'pending';

/**
 * The exact 13-value BFMR tracker status enum that the sync-reservations route
 * pages over, in this order. Pure data -- no imports, no functions.
 */
export const BFMR_ALL_TRACKER_STATUSES = ['purchased', 'reserved', 'return', 'payment_error', 'shipped', 'processed', 'set_aside', 'paid', 'cancelled', 'returned', 'closed', 'deadline', 'pkg_received'] as const;

/** One of the 13 tracker statuses above. */
export type BfmrTrackerStatus = (typeof BFMR_ALL_TRACKER_STATUSES)[number];

const DEFAULT_BFMR_SYNC_SCOPE: BfmrSyncScope = 'all';

/**
 * Coerce an untrusted raw sync-scope value (query string / localStorage) into
 * a valid scope. Strict, case-sensitive equality; anything else falls back to
 * the default. Never throws.
 */
export function parseBfmrSyncScope(raw: unknown): BfmrSyncScope {
  if (raw === 'all' || raw === 'pending') {
    return raw;
  }
  return DEFAULT_BFMR_SYNC_SCOPE;
}
