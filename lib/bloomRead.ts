// What the tracker knows about one live read of a Bloom Ledger month. A failed, timed-out or suspiciously empty read must
// never turn into "$0": the last good figure is kept with the time it was read, and only a read that succeeded and found
// nothing counts as "no earnings". Pure; lib/bloomInvoiceService.ts keeps the entries in memory.
import type { InvoiceMoney } from './bloomInvoice';

export type ReadEntry = {
  /** Last figure the ledger really gave us (may be an honest empty one). */
  good: InvoiceMoney | null;
  /** When `good` was read, ms since epoch. */
  goodAt: number | null;
  /** When we last tried, ms since epoch. */
  checkedAt: number;
  /** The latest try failed (or answered empty after earnings were already seen). */
  failed: boolean;
};
export type ReadOutcome = { ok: true; value: InvoiceMoney } | { ok: false };
export type BloomState = 'off' | 'ok' | 'none' | 'stale' | 'unavailable';
export type BloomStatus = { state: BloomState; /** ISO time of the figure shown, when it is not fresh. */ asOf: string | null };

export const READ_TTL_MS = 5 * 60_000;
export const READ_FAIL_TTL_MS = 60_000;

export function isEmptyMoney(v: InvoiceMoney): boolean {
  return v.grossCents === 0 && v.otherIncomeCents === 0 && v.netCents === 0;
}

/** Fold one read attempt into the entry. A month to date does not fall back to nothing once earnings were seen, so an
 *  all-zero answer after a real one (the ledger mid-rewrite, just restarted) is held back like a failure. */
export function applyRead(prev: ReadEntry | undefined, outcome: ReadOutcome, now: number): ReadEntry {
  const good = prev?.good ?? null;
  const goodAt = prev?.goodAt ?? null;
  if (!outcome.ok) return { good, goodAt, checkedAt: now, failed: true };
  if (good && !isEmptyMoney(good) && isEmptyMoney(outcome.value)) return { good, goodAt, checkedAt: now, failed: true };
  return { good: outcome.value, goodAt: now, checkedAt: now, failed: false };
}

/** Whether the entry is recent enough to skip a new read. A failure is retried sooner. */
export function isFresh(e: ReadEntry | undefined, now: number): boolean {
  return !!e && now - e.checkedAt < (e.failed ? READ_FAIL_TTL_MS : READ_TTL_MS);
}

/** The figure to count in the P&L: the last good one, even when the latest read failed; null when there is none or it is empty. */
export function moneyToShow(e: ReadEntry | undefined): InvoiceMoney | null {
  if (!e?.good || isEmptyMoney(e.good)) return null;
  return e.good;
}

/** One state for all the months read live. Worst first: unavailable, stale, ok, none. `reads` empty means nothing needed reading. */
export function summarizeReads(reads: (ReadEntry | undefined)[]): BloomStatus {
  if (!reads.length) return { state: 'ok', asOf: null };
  if (reads.some(e => !e || (e.failed && !e.good))) return { state: 'unavailable', asOf: null };
  const stale = reads.filter((e): e is ReadEntry => !!e && e.failed);
  if (stale.length) {
    const oldest = Math.min(...stale.map(e => e.goodAt ?? 0));
    return { state: 'stale', asOf: new Date(oldest).toISOString() };
  }
  return reads.every(e => e && e.good && isEmptyMoney(e.good)) ? { state: 'none', asOf: null } : { state: 'ok', asOf: null };
}
