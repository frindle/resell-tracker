import {
  matchOrder, bfmrCandidates, bgCandidates, bigskyCandidates,
  type Candidate, type MatchOutcome, type BfmrRow, type BgRow, type BigSkyRow,
} from './commitmentMatch.ts';

// The decision loop of lib/commitmentMatchRun.ts with its database access
// injected, so it can be tested without one.

export type MatchRunResult = {
  linked: number;
  /** Orders left unlinked, with why. Never includes orders that were skipped as already linked. */
  unplaced: { orderId: number; reason: Exclude<MatchOutcome['kind'], 'link'> }[];
};

export type MatchStore = {
  /** Orders from the id list that are unlinked, not cancelled, not locked and belong to the user. */
  loadOrders(ids: readonly number[]): Promise<{ id: number; itemDescription: string | null; orderDate: Date }[]>;
  loadCandidateRows(): Promise<{ bfmr: BfmrRow[]; bg: BgRow[]; bigsky: BigSkyRow[] }>;
  /** Write the link and everything that follows from it. */
  link(candidate: Candidate, orderId: number, quantity: number): Promise<void>;
};

export async function matchOrdersWith(
  store: MatchStore,
  orderIds: readonly number[],
  quantities: ReadonlyMap<number, number>,
  nowMs: number,
): Promise<MatchRunResult> {
  const result: MatchRunResult = { linked: 0, unplaced: [] };
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
    const out = matchOrder({ itemDescription: o.itemDescription, quantity: known, orderDateMs: o.orderDate.getTime() }, candidates());
    if (out.kind !== 'link') {
      result.unplaced.push({ orderId: o.id, reason: out.kind });
      continue;
    }
    const c = out.candidate;
    const quantity = known ?? 1;
    try {
      await store.link(c, o.id, quantity);
      taken.set(key(c), (taken.get(key(c)) ?? 0) + quantity);
      result.linked++;
    } catch (e) {
      console.warn(`[commitment-match] link failed group=${c.group}:`, String(e).slice(0, 160));
    }
  }
  console.log(`[commitment-match] orders=${orders.length} linked=${result.linked} unplaced=${result.unplaced.length}`);
  return result;
}
