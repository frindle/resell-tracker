/**
 * Sync scope for the BFMR pending-sync flow.
 *
 * "all" pulls every reservation from BFMR; "pending" restricts the pull to
 * reservations still awaiting sync. The raw value arrives untrusted (query
 * string / localStorage), so callers must go through parseBfmrSyncScope and
 * never trust a bare string.
 */

export type BfmrSyncScope = 'all' | 'pending';

/** Default when the raw value is absent or unrecognised. */
const DEFAULT_BFMR_SYNC_SCOPE: BfmrSyncScope = 'all';

/**
 * Coerce an unknown raw value into a valid BfmrSyncScope.
 *
 * Accepts exactly the two canonical strings, case-sensitively and without
 * trimming; anything else (null, undefined, numbers, objects, arrays, empty
 * or padded/case-variant strings) falls back to the default 'all'. Never
 * throws: this runs on untrusted input at module boundaries.
 */
export function parseBfmrSyncScope(raw: unknown): BfmrSyncScope {
  if (raw === 'all' || raw === 'pending') return raw;
  return DEFAULT_BFMR_SYNC_SCOPE;
}
