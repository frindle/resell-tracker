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

export function sweepCandidateIds(orders: SweepOrder[], nowMs: number): number[] {
  const since = nowMs - SWEEP_DAYS * 86400000;
  return orders
    .filter(o =>
      !o.cancelled && !o.locked && !o.trackingSubmittedToBg &&
      !!o.trackingNumbers && o.trackingNumbers.split(',').some(t => t.trim()) &&
      autoSubmitChannel(o.buyerName) !== null &&
      (o.orderDate == null || o.orderDate.getTime() >= since))
    .map(o => o.id);
}
