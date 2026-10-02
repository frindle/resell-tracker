import type { BfmrSyncScope } from './bfmrSyncScope';

export type BfmrSyncTrigger = 'order-open' | 'manual' | 'scheduled' | 'sidecar';

/**
 * Frozen trigger -> scope policy. 'order-open' is the ONLY trigger that gets
 * the narrow, cheap pull; manual and scheduled keep the full scope so the
 * myTrackerId web backfill still runs somewhere. Unknown triggers fail safe
 * to 'all' -- never silently narrow a sync.
 */
export const SYNC_TRIGGER_SCOPES: Readonly<Record<BfmrSyncTrigger, BfmrSyncScope>> = Object.freeze({
  'order-open': 'pending',
  // Penn 2026-10-02: syncs are manual only (no bot-looking background pulls) and the
  // normal pull is the open statuses; finished ones are looked up per order number.
  manual: 'open',
  sidecar: 'open',
  scheduled: 'all',
});

/**
 * Decide which scope a caller of POST /api/bfmr/sync-reservations is entitled
 * to. Pure and total: never throws for any input type, and anything that is
 * not exactly one of the known triggers falls back to 'all'.
 */
export function scopeForSyncTrigger(trigger: unknown): BfmrSyncScope {
  if (trigger === 'order-open' || trigger === 'manual' || trigger === 'scheduled' || trigger === 'sidecar') {
    return SYNC_TRIGGER_SCOPES[trigger];
  }
  return 'all';
}
