import {
  matchOrder, bfmrCandidates, bgCandidates, bigskyCandidates,
  type Candidate, type MatchOutcome, type BfmrRow, type BgRow, type BigSkyRow,
} from './commitmentMatch.ts';

// The decision loop of lib/commitmentMatchRun.ts with its database access
// injected, so it can be tested without one.

export type MatchRunResult = {
  linked: number;
  /** Orders left unlinked, with why. Never includes orders that were skipped as already linked. */
  unplaced: { orderId: number; reason: Exclude<MatchOutcome['kind'], 'link'>; detail?: string }[];
  /** One short line per order: id and why it was or was not linked. No names, numbers or addresses. */
  lines: string[];
};

export type MatchStore = {
  /** Orders from the id list that are unlinked, not cancelled, not locked and belong to the user. */
  loadOrders(ids: readonly number[]): Promise<{
    id: number; itemDescription: string | null; orderDate: Date;
    subtotalAmount?: number | null; cost?: number | null; buyer?: { name: string } | null;
    /** ASINs and the like from the order's captured packages. */
    identifiers?: readonly string[];
  }[]>;
  loadCandidateRows(): Promise<{ bfmr: BfmrRow[]; bg: BgRow[]; bigsky: BigSkyRow[] }>;
  /** Write the link and everything that follows from it. */
  link(candidate: Candidate, orderId: number, quantity: number): Promise<void>;
};

export async function matchOrdersWith(
  store: MatchStore,
  orderIds: readonly number[],
  quantities: ReadonlyMap<number, number>,
  nowMs: number,
  /** Item counts from a placeholder name the order had before its real name came in ("Apple (2 items)"). */
  itemCounts: ReadonlyMap<number, number> = new Map(),
): Promise<MatchRunResult> {
  const result: MatchRunResult = { linked: 0, unplaced: [], lines: [] };
  if (!orderIds.length) return result;
  const orders = await store.loadOrders(orderIds);
  if (!orders.length) return result;
  const rows = await store.loadCandidateRows();

  // Units claimed in this run come off what the next order sees.
  const taken = new Map<string, number>();
  const key = (c: Candidate) => `${c.group}:${c.id}`;
  const candidates = (): Candidate[] => [
    ...bfmrCandidates(rows.bfmr),
    ...bgCandidates(rows.bg, nowMs),
    ...bigskyCandidates(rows.bigsky, nowMs),
  ].map(c => ({ ...c, remaining: c.remaining - (taken.get(key(c)) ?? 0) })).filter(c => c.remaining > 0);

  for (const o of orders) {
    const real = quantities.get(o.id);
    const known = real != null && Number.isInteger(real) && real > 0 ? real : null;
    const out = matchOrder({
      itemDescription: o.itemDescription, quantity: known, orderDateMs: o.orderDate.getTime(),
      amount: o.subtotalAmount ?? o.cost ?? null,
      buyer: o.buyer === undefined ? undefined : o.buyer?.name ?? null,
      itemCount: itemCounts.get(o.id) ?? null,
      identifiers: o.identifiers,
    }, candidates());
    if (out.kind !== 'link') {
      const detail = out.kind === 'none' ? out.detail : out.kind === 'several' ? `${out.candidates.length} rows` : undefined;
      result.unplaced.push({ orderId: o.id, reason: out.kind, ...(detail ? { detail } : {}) });
      result.lines.push(`order ${o.id}: not linked, ${out.kind}${detail ? ` (${detail})` : ''}`);
      continue;
    }
    const done: string[] = [];
    for (const al of out.allocations) {
      const c = al.candidate;
      try {
        await store.link(c, o.id, al.quantity);
        taken.set(key(c), (taken.get(key(c)) ?? 0) + al.quantity);
        done.push(`${c.group} x${al.quantity}`);
      } catch (e) {
        console.warn(`[commitment-match] link failed group=${c.group}:`, String(e).slice(0, 160));
        break;
      }
    }
    if (done.length) {
      result.linked++;
      result.lines.push(`order ${o.id}: linked ${done.join(' + ')} by ${out.by}`);
    } else {
      result.unplaced.push({ orderId: o.id, reason: 'none', detail: 'write-failed' });
      result.lines.push(`order ${o.id}: not linked, write failed`);
    }
  }
  console.log(`[commitment-match] orders=${orders.length} linked=${result.linked} unplaced=${result.unplaced.length}`);
  return result;
}
