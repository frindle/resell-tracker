// Batch submit of pending gift cards to CardCenter: the pure planning and
// result-aggregation half. No I/O, so it is unit-tested with invented values.
import { canonicalGiftBrand } from './giftBrand.ts';
import { pickCurrentRate, type BuyOrderRate } from './ccWaitlist.ts';

export type BatchCard = {
  id: number;
  orderId: number;
  merchant: string;
  value: number;
  ccSubmittedAt: Date | string | null;
  /** eGift card still waiting for a person to set merchant/value. */
  needsReview: boolean;
};

export type SkipReason = 'not_found' | 'already_submitted' | 'needs_review' | 'no_rate';

export type BatchGroup = {
  buyOrderId: number;
  orderId: number;
  brand: string;
  /** Denomination of every card in the group. */
  value: number;
  /** Fraction of face value, e.g. 0.85. */
  rate: number;
  cardIds: number[];
  face: number;
  payout: number;
};

export type BatchPlan = {
  groups: BatchGroup[];
  skipped: Array<{ id: number; reason: SkipReason }>;
  count: number;
  face: number;
  payout: number;
  brands: string[];
};

const cents = (n: number) => Math.round(n * 100) / 100;

/**
 * Group the requested cards by (buy order, order). One CardCenter reservation
 * is made per group. Cards of different tracker orders are kept apart because
 * the reserve flow books the sale price and payment date onto the FIRST card's
 * order only. Skips are reported, never thrown: a card already submitted, one
 * needing review, one with no live rate, or an id that is not the user's.
 */
export function planBatch(
  requestedIds: readonly number[],
  cards: readonly BatchCard[],
  rates: readonly BuyOrderRate[],
): BatchPlan {
  const byId = new Map(cards.map(c => [c.id, c]));
  const skipped: BatchPlan['skipped'] = [];
  const groups = new Map<string, BatchGroup>();

  for (const id of new Set(requestedIds)) {
    const card = byId.get(id);
    if (!card) { skipped.push({ id, reason: 'not_found' }); continue; }
    if (card.ccSubmittedAt) { skipped.push({ id, reason: 'already_submitted' }); continue; }
    if (card.needsReview) { skipped.push({ id, reason: 'needs_review' }); continue; }
    const rate = pickCurrentRate(card, [...rates]);
    if (!rate) { skipped.push({ id, reason: 'no_rate' }); continue; }
    const key = `${rate.id}:${card.orderId}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        buyOrderId: rate.id, orderId: card.orderId,
        brand: canonicalGiftBrand(card.merchant) || rate.brandName,
        value: rate.value, rate: rate.rate, cardIds: [], face: 0, payout: 0,
      };
      groups.set(key, g);
    }
    g.cardIds.push(id);
    g.face = cents(g.face + card.value);
    g.payout = cents(g.payout + card.value * rate.rate);
  }

  const list = [...groups.values()]
    .map(g => ({ ...g, cardIds: [...g.cardIds].sort((a, b) => a - b) }))
    .sort((a, b) => a.brand.localeCompare(b.brand) || a.value - b.value || a.buyOrderId - b.buyOrderId || a.orderId - b.orderId);
  return {
    groups: list,
    skipped: skipped.sort((a, b) => a.id - b.id),
    count: list.reduce((n, g) => n + g.cardIds.length, 0),
    face: cents(list.reduce((n, g) => n + g.face, 0)),
    payout: cents(list.reduce((n, g) => n + g.payout, 0)),
    brands: [...new Set(list.map(g => g.brand))],
  };
}

export type CardResult = {
  id: number;
  status: 'submitted' | 'failed' | 'skipped';
  reason?: string;
};

export type GroupOutcome = {
  group: BatchGroup;
  /** Card ids the database now shows as submitted for this group. */
  submittedIds: number[];
  /** Why the rest did not go through, when the group did not fully succeed. */
  error?: string;
};

export type BatchSummary = {
  results: CardResult[];
  submitted: number;
  failed: number;
  skipped: number;
};

const SKIP_TEXT: Record<SkipReason, string> = {
  not_found: 'Card not found',
  already_submitted: 'Already submitted',
  needs_review: 'Needs review: set its merchant and value first',
  no_rate: 'No live CardCenter rate for this brand and value',
};

/** One result per card: skipped by the plan, submitted, or failed with the group's error. */
export function aggregateBatch(plan: BatchPlan, outcomes: readonly GroupOutcome[]): BatchSummary {
  const results: CardResult[] = plan.skipped.map(s => ({ id: s.id, status: 'skipped', reason: SKIP_TEXT[s.reason] }));
  for (const o of outcomes) {
    const done = new Set(o.submittedIds);
    for (const id of o.group.cardIds) {
      results.push(done.has(id)
        ? { id, status: 'submitted' }
        : { id, status: 'failed', reason: o.error ?? 'Not submitted' });
    }
  }
  results.sort((a, b) => a.id - b.id);
  const n = (s: CardResult['status']) => results.filter(r => r.status === s).length;
  return { results, submitted: n('submitted'), failed: n('failed'), skipped: n('skipped') };
}
