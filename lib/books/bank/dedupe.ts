// Dedupe for bank transactions: ids for rows that have none, and the pure insert/update/delete plan for an ingest.
import { createHash } from 'node:crypto';
import type { BankTxnIn } from './types.ts';

export const normDesc = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Stable ids for rows without a provider id: a hash of date + amount + normalized description + an occurrence index
 * (the nth identical row in the same file/batch gets index n), so two real identical charges stay two rows and
 * re-importing the same file gives the same ids.
 */
export function assignHashIds<T extends Omit<BankTxnIn, 'providerTxnId'>>(rows: T[]): (T & { providerTxnId: string })[] {
  const seen = new Map<string, number>();
  return rows.map(r => {
    const key = `${r.postedDate}|${r.amountCents}|${normDesc(r.description)}`;
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    const h = createHash('sha256').update(`${key}|${n}`).digest('hex').slice(0, 20);
    return { ...r, providerTxnId: `h:${h}` };
  });
}

export type ExistingTxn = { id: number; providerTxnId: string; postedDate: string; pending: boolean; matchStatus: string; amountCents: number; description: string; transactedDate: string | null };
export type IngestPlan = { insert: BankTxnIn[]; update: { id: number; row: BankTxnIn }[]; deleteIds: number[] };

/**
 * Compare incoming rows with what is stored for one account.
 *  - same providerTxnId: update in place (a pending row that posts keeps its id and its match status, no duplicate);
 *    skipped when nothing changed.
 *  - a stored pending row inside [windowStart, windowEnd] that the provider no longer sends, and that nobody has
 *    matched, is deleted (the bank dropped it or re-issued it under a new id when it posted).
 *  Duplicates inside `incoming` (same id) keep the last one.
 */
export function planIngest(existing: ExistingTxn[], incoming: BankTxnIn[], window: { windowStart: string; windowEnd: string } | null): IngestPlan {
  const byId = new Map(existing.map(e => [e.providerTxnId, e]));
  const last = new Map<string, BankTxnIn>();
  for (const r of incoming) last.set(r.providerTxnId, r);
  const plan: IngestPlan = { insert: [], update: [], deleteIds: [] };
  for (const r of last.values()) {
    const e = byId.get(r.providerTxnId);
    if (!e) { plan.insert.push(r); continue; }
    const same = e.postedDate === r.postedDate && e.pending === r.pending && e.amountCents === r.amountCents
      && e.description === r.description && e.transactedDate === r.transactedDate;
    if (!same) plan.update.push({ id: e.id, row: r });
  }
  if (window) {
    for (const e of existing) {
      if (e.pending && !last.has(e.providerTxnId) && e.matchStatus !== 'matched' && e.postedDate >= window.windowStart && e.postedDate <= window.windowEnd) {
        plan.deleteIds.push(e.id);
      }
    }
  }
  return plan;
}
