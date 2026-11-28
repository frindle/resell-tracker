import { autoSubmitChannel } from './autoSubmitChannel.ts';

// Which orders the periodic tracking sweep should hand to autoSubmitTrackingForOrders.
// Upload-time auto-submit only runs when tracking changes (import, PUT, PATCH). An order whose
// buyer was set AFTER its tracking arrived (group fill, BigSky sync, manual pick) or whose first
// submit failed was never retried, so it sat at "Tracking not uploaded". The sweep retries them.

export const SWEEP_DAYS = 45;

export interface SweepOrder {
  id: number;
  orderDate: Date | null;
  trackingNumbers: string | null;
  trackingSubmittedToBg: boolean;
  cancelled: boolean;
  locked: boolean;
  buyerName: string | null;
}

/** Retry spacing for an order a sweep already handed over that is still not submitted: 15 min doubling, capped at a day. */
export type SweepBackoff = Map<number, { tries: number; nextMs: number }>;
const RETRY_BASE_MS = 15 * 60 * 1000;
const RETRY_CAP_MS = 24 * 60 * 60 * 1000;

export function sweepCandidateIds(orders: SweepOrder[], nowMs: number, backoff?: SweepBackoff): number[] {
  const since = nowMs - SWEEP_DAYS * 86400000;
  const out = orders
    .filter(o =>
      !o.cancelled && !o.locked && !o.trackingSubmittedToBg &&
      !!o.trackingNumbers && o.trackingNumbers.split(',').some(t => t.trim()) &&
      autoSubmitChannel(o.buyerName) !== null &&
      (o.orderDate == null || o.orderDate.getTime() >= since))
    .map(o => o.id);
  if (!backoff) return out;
  // Orders no longer pending (submitted, cancelled, aged out) drop out of the backoff.
  const live = new Set(out);
  for (const id of [...backoff.keys()]) if (!live.has(id)) backoff.delete(id);
  return out.filter(id => {
    const b = backoff.get(id);
    if (b && nowMs < b.nextMs) return false;
    const tries = (b?.tries ?? 0) + 1;
    backoff.set(id, { tries, nextMs: nowMs + Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** (tries - 1)) });
    return true;
  });
}
