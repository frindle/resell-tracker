// CardCenter pending page: unsold cards grouped by brand, and the pick of
// which selected cards fit under a payout cap. Pure, no I/O.
import { canonicalGiftBrand } from './giftBrand.ts';

export type PendingCard = {
  id: number;
  merchant: string;
  value: number;
  currentRate: number | null;
};

export type BrandGroup<T extends PendingCard> = {
  brand: string;
  cards: T[];
  count: number;
  face: number;
  /** Payout if every card with a live rate sold at it now. */
  payoutNow: number;
  /** Best live rate across the brand's cards, or null when none has one. */
  bestRate: number | null;
};

const cents = (n: number) => Math.round(n * 100) / 100;

/** Cards grouped under their canonical brand, brands A-Z, cards by value then id. */
export function groupByBrand<T extends PendingCard>(cards: readonly T[]): BrandGroup<T>[] {
  const map = new Map<string, T[]>();
  for (const c of cards) {
    const b = canonicalGiftBrand(c.merchant) || 'Unknown';
    const g = map.get(b);
    if (g) g.push(c); else map.set(b, [c]);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([brand, list]) => {
      const sorted = [...list].sort((a, b) => a.value - b.value || a.id - b.id);
      let face = 0, payoutNow = 0;
      let bestRate: number | null = null;
      for (const c of sorted) {
        face += c.value;
        if (c.currentRate != null) {
          payoutNow += c.value * c.currentRate;
          if (bestRate == null || c.currentRate > bestRate) bestRate = c.currentRate;
        }
      }
      return { brand, cards: sorted, count: sorted.length, face: cents(face), payoutNow: cents(payoutNow), bestRate };
    });
}

export type PayoutPick = {
  /** Card ids to put on the waitlist, in the order taken. */
  take: number[];
  /** Card ids left off because the next one would pass the cap. */
  left: number[];
  /** Payout of `take` at `rate`. */
  payout: number;
};

/**
 * Which selected cards to waitlist so their payout at `rate` stays at or
 * under `maxPayout`. Cards are taken oldest first (lowest id), and a card
 * that would pass the cap is skipped while smaller ones after it may still
 * fit. No cap (null) takes every card.
 */
export function pickUnderPayout(
  cards: ReadonlyArray<{ id: number; value: number }>,
  rate: number,
  maxPayout: number | null,
): PayoutPick {
  const ordered = [...cards].sort((a, b) => a.id - b.id);
  const take: number[] = [];
  const left: number[] = [];
  let payout = 0;
  for (const c of ordered) {
    const p = c.value * rate;
    // A hair of slack so float drift never drops a card that fits exactly.
    if (maxPayout == null || payout + p <= maxPayout + 1e-9) {
      take.push(c.id);
      payout += p;
    } else {
      left.push(c.id);
    }
  }
  return { take, left, payout: cents(payout) };
}
