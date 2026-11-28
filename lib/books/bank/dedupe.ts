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
export type IngestPlan = {
  insert: BankTxnIn[];
  /** `rekey`: a stale pending row takes over the posted row's new provider id (and its data), keeping its links. */
  update: { id: number; row: BankTxnIn; rekey?: boolean; tier?: number }[];
  deleteIds: number[];
  /** The links of a stale pending row move to a posted row stored earlier; the pending row is in deleteIds. */
  moves: { fromId: number; toId: number; tier: number }[];
  /** Rows with links (matched or ignored) whose amount changed when they posted: their links no longer add up. */
  amountChanged: { id: number; fromCents: number; toCents: number }[];
};

/** A row the user or a rule acted on: its links must survive the bank re-issuing or re-pricing it. */
const hasLinks = (s: string) => s === 'matched' || s === 'ignored';

/**
 * True when a row with links has links that no longer add up to its amount: the bank changed the amount when the row posted
 * (a tip, a fuel hold). The Bank tab flags it so the user re-checks; nothing is rewritten. Shortfall links are on top of
 * the amount, not part of it.
 */
export function linksOffAmount(t: { amountCents: number; matchStatus: string }, links: { kind: string; amountCents: number }[]): boolean {
  if (!hasLinks(t.matchStatus) || links.length === 0) return false;
  return links.filter(l => l.kind !== 'payout_shortfall').reduce((x, l) => x + l.amountCents, 0) !== Math.abs(t.amountCents);
}

const DAY_MS = 86_400_000;
const dayGap = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);
/** The merchant words of a description: no numbers, no short tokens, no "pending"/"pos"-style noise. */
const NOISE = new Set(['pending', 'pos', 'purchase', 'debit', 'credit', 'card', 'auth', 'authorization', 'ach', 'web', 'online', 'recurring']);
const merchantWords = (s: string) => normDesc(s).split(' ').filter(w => w.length > 2 && !/\d/.test(w) && !NOISE.has(w));
export function sameMerchant(a: string, b: string): boolean {
  const A = merchantWords(a).slice(0, 2), B = new Set(merchantWords(b));
  return A.some(w => B.has(w));
}

type Candidate = { amountCents: number; postedDate: string; description: string; insert?: BankTxnIn; existingId?: number };

/**
 * The posted row a vanished pending row became, or null. Same sign, posted 1 day before to 10 days after the pending
 * date, and one of, in order (each must be the only one of its kind): the same amount and merchant; the same merchant
 * at a different amount (a tip, a fuel hold); the same amount within 5 days whatever the description says.
 */
export function postedTwin(e: ExistingTxn, pool: Candidate[], opts: { amountOnly?: boolean } = {}): Candidate | null {
  return twinTier(e, pool, opts.amountOnly ?? true)?.twin ?? null;
}

/** postedTwin with the tier (1, 2 or 3) that found it. Tier 3 (amount only) is allowed only when `amountOnly` is set. */
function twinTier(e: ExistingTxn, pool: Candidate[], amountOnly: boolean): { twin: Candidate; tier: number } | null {
  const near = pool.filter(c => Math.sign(c.amountCents) === Math.sign(e.amountCents)
    && dayGap(e.postedDate, c.postedDate) >= -1 && dayGap(e.postedDate, c.postedDate) <= 10);
  const only = (xs: Candidate[]) => (xs.length === 1 ? xs[0] : null);
  const merchant = near.filter(c => sameMerchant(e.description, c.description));
  const t1 = only(merchant.filter(c => c.amountCents === e.amountCents));
  if (t1) return { twin: t1, tier: 1 };
  const t2 = only(merchant);
  if (t2) return { twin: t2, tier: 2 };
  const t3 = amountOnly ? only(near.filter(c => c.amountCents === e.amountCents && dayGap(e.postedDate, c.postedDate) <= 5)) : null;
  return t3 ? { twin: t3, tier: 3 } : null;
}

/**
 * Compare incoming rows with what is stored for one account.
 *  - same providerTxnId: update in place (a pending row that posts keeps its id and its match status, no duplicate);
 *    skipped when nothing changed. If a row with links changes amount, it is listed in amountChanged.
 *  - a stored pending row inside [windowStart, windowEnd] that the provider no longer sends was dropped, or re-issued
 *    under a new id when it posted. Unless the user or a rule acted on it, it is deleted. If they did, its posted twin
 *    (postedTwin, among this batch's new rows first, then stored open posted rows; a stored row only by merchant) inherits it: a new row is stored as
 *    the old one under the new id (rekey), a stored one gets its links (moves). With no twin it is kept as it is.
 *  Duplicates inside `incoming` (same id) keep the last one.
 */
export function planIngest(existing: ExistingTxn[], incoming: BankTxnIn[], window: { windowStart: string; windowEnd: string } | null): IngestPlan {
  const byId = new Map(existing.map(e => [e.providerTxnId, e]));
  const last = new Map<string, BankTxnIn>();
  for (const r of incoming) last.set(r.providerTxnId, r);
  const plan: IngestPlan = { insert: [], update: [], deleteIds: [], moves: [], amountChanged: [] };
  for (const r of last.values()) {
    const e = byId.get(r.providerTxnId);
    if (!e) { plan.insert.push(r); continue; }
    const same = e.postedDate === r.postedDate && e.pending === r.pending && e.amountCents === r.amountCents
      && e.description === r.description && e.transactedDate === r.transactedDate;
    if (!same) plan.update.push({ id: e.id, row: r });
    if (e.amountCents !== r.amountCents && hasLinks(e.matchStatus)) plan.amountChanged.push({ id: e.id, fromCents: e.amountCents, toCents: r.amountCents });
  }
  if (!window) return plan;
  const stale = existing
    .filter(e => e.pending && !last.has(e.providerTxnId) && e.postedDate >= window.windowStart && e.postedDate <= window.windowEnd)
    .sort((a, b) => a.postedDate.localeCompare(b.postedDate) || a.id - b.id);
  const fresh: Candidate[] = plan.insert.filter(r => !r.pending).map(r => ({ amountCents: r.amountCents, postedDate: r.postedDate, description: r.description, insert: r }));
  const stored: Candidate[] = existing
    .filter(e => !e.pending && (e.matchStatus === 'unmatched' || e.matchStatus === 'suggested'))
    .map(e => { const r = last.get(e.providerTxnId); return { amountCents: r?.amountCents ?? e.amountCents, postedDate: r?.postedDate ?? e.postedDate, description: r?.description ?? e.description, existingId: e.id }; });
  const taken = new Set<Candidate>();
  for (const e of stale) {
    if (!hasLinks(e.matchStatus)) { plan.deleteIds.push(e.id); continue; }
    const hit = twinTier(e, fresh.filter(c => !taken.has(c)), true) ?? twinTier(e, stored.filter(c => !taken.has(c)), false);
    if (!hit) continue;
    const { twin, tier } = hit;
    taken.add(twin);
    if (twin.insert) {
      plan.insert = plan.insert.filter(r => r !== twin.insert);
      plan.update.push({ id: e.id, row: twin.insert, rekey: true, tier });
      if (twin.amountCents !== e.amountCents) plan.amountChanged.push({ id: e.id, fromCents: e.amountCents, toCents: twin.amountCents });
    } else {
      plan.moves.push({ fromId: e.id, toId: twin.existingId!, tier });
      plan.deleteIds.push(e.id);
      if (twin.amountCents !== e.amountCents) plan.amountChanged.push({ id: twin.existingId!, fromCents: e.amountCents, toCents: twin.amountCents });
    }
  }
  return plan;
}
