// Pure scheduling helpers for the SimpleFIN sync: which dates to ask for, and the rolling 24-hour request budget.
import { laDay } from '../dates.ts';
import { DAILY_REQUEST_BUDGET, OVERLAP_DAYS } from './simplefin.ts';

export const INITIAL_BACKFILL_DAYS = 365;
export const MIN_MANUAL_SYNC_GAP_MS = 5 * 60 * 1000;

export function pruneRequestLog(log: number[], now: number): number[] {
  return log.filter(t => now - t < 24 * 3600 * 1000);
}
/** True when `n` more requests fit in the rolling 24 hours. */
export function budgetAllows(log: number[], now: number, n: number): boolean {
  return pruneRequestLog(log, now).length + n <= DAILY_REQUEST_BUDGET;
}

/** The [startDay, endDay) window for a sync. endDay is tomorrow because end-date is exclusive. */
export function syncRange(lastSyncAt: Date | null, now: Date): { startDay: string; endDay: string } {
  const today = laDay(now);
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  const endDay = new Date(todayMs + 86400000).toISOString().slice(0, 10);
  const back = lastSyncAt
    ? Math.min(INITIAL_BACKFILL_DAYS, Math.ceil((now.getTime() - lastSyncAt.getTime()) / 86400000) + OVERLAP_DAYS)
    : INITIAL_BACKFILL_DAYS;
  const startDay = new Date(todayMs - back * 86400000).toISOString().slice(0, 10);
  return { startDay, endDay };
}
