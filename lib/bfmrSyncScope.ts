export type BfmrSyncScope = 'all' | 'pending';

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
