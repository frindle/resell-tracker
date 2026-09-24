import type { BfmrSyncScope } from './bfmrSyncScope';

export type BfmrSyncTrigger = 'order-open' | 'manual' | 'scheduled';

/**
 * Frozen trigger -> scope policy. 'order-open' is the ONLY trigger that gets
 * the narrow, cheap pull; manual and scheduled keep the full scope so the
 * myTrackerId web backfill still runs somewhere. Unknown triggers fail safe
 * to 'all' -- never silently narrow a sync.
 */
export const SYNC_TRIGGER_SCOPES: Readonly<Record<BfmrSyncTrigger, BfmrSyncScope>> = Object.freeze({
  'order-open': 'pending',
  manual: 'all',
  scheduled: 'all',
});

/**
 * Decide which scope a caller of POST /api/bfmr/sync-reservations is entitled
 * to. Pure and total: never throws for any input type, and anything that is
 * not exactly one of the known triggers falls back to 'all'.
 */
export function scopeForSyncTrigger(trigger: unknown): BfmrSyncScope {
  if (trigger === 'order-open' || trigger === 'manual' || trigger === 'scheduled') {
    return SYNC_TRIGGER_SCOPES[trigger];
  }
  return 'all';
}
