// Waitlist decision + batch runner for credit-card waitlists.
// Dates are YYYY-MM-DD strings compared lexicographically; maxDate is the
// deadline and its day is INCLUSIVE (today == maxDate still decides on rate).

export interface WaitlistCard {
  id: string | number;
  targetRate: number;
  maxDate: string;
}

export type WaitlistDecision = 'SUBMIT' | 'WAIT' | 'EXPIRE';

export interface WaitlistHooks {
  submit: (card: WaitlistCard) => void | Promise<void>;
  onExpire: (card: WaitlistCard) => void | Promise<void>;
}

export interface WaitlistSummary {
  submitted: Array<string | number>;
  waiting: Array<string | number>;
  expired: Array<string | number>;
  errors: Array<{ id: string | number; message: string }>;
}

/**
 * Pure decision for one card. No network, no database, no clock read -- the
 * day arrives as `today`, which is what makes the deadline testable.
 */
export function decideWaitlist(card: WaitlistCard, currentRate: number, today: string): WaitlistDecision {
  if (today > card.maxDate) return 'EXPIRE';
  if (currentRate >= card.targetRate) return 'SUBMIT';
  return 'WAIT';
}

const toMessage = (e: unknown): string => e instanceof Error ? e.message : typeof e === 'string' ? e : JSON.stringify(e) ?? String(e);

/**
 * Iterate cards in input order, applying decideWaitlist to each. SUBMIT fires
 * hooks.submit, EXPIRE fires hooks.onExpire (surfaces the lapsed waitlist),
 * WAIT fires neither. A throwing hook records ONE entry in errors for that
 * card and the run continues; it never throws out.
 */
export async function runWaitlist(
  cards: WaitlistCard[],
  currentRate: number,
  today: string,
  hooks: WaitlistHooks,
): Promise<WaitlistSummary> {
  const summary: WaitlistSummary = { submitted: [], waiting: [], expired: [], errors: [] };
  for (const card of cards) {
    try {
      const decision = decideWaitlist(card, currentRate, today);
      if (decision === 'SUBMIT') {
        await hooks.submit(card);
        summary.submitted.push(card.id);
      } else if (decision === 'EXPIRE') {
        await hooks.onExpire(card);
        summary.expired.push(card.id);
      } else {
        summary.waiting.push(card.id);
      }
    } catch (e) {
      summary.errors.push({ id: card.id, message: toMessage(e) });
    }
  }
  return summary;
}

// --- rate selection -------------------------------------------------------
// A card cannot be decided against "the rate" in the abstract: CardCenter
// quotes a rate per brand AND denomination, and several rows can match one
// card. These pick the row that actually applies and decide a whole batch
// against a live rate list, still without touching the clock or the network.

/** One row of CardCenter's buy-order list, as GET /api/cardcenter/rates returns it. */
export interface BuyOrderRate {
  /** buyOrderId — what a reservation is placed against. */
  id: number;
  brandName: string;
  /** Denomination this rate applies to. */
  value: number;
  /** Fraction of face value, e.g. 0.85. */
  rate: number;
  /** Remaining capacity; <= 0 means the row cannot be sold into. */
  availableCap: number;
}

/** A waitlisted card with the brand/denomination needed to find its rate. */
export interface WaitlistCardWithBrand extends WaitlistCard {
  merchant: string;
  value: number;
}

export interface WaitlistPlanEntry {
  card: WaitlistCardWithBrand;
  decision: WaitlistDecision;
  /** The rate row that decided it, or null when no usable rate was found. */
  rate: BuyOrderRate | null;
}

/** Trim and collapse internal whitespace, lowercased — NOT the same as removing spaces. */
const normBrand = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Best usable buy-order rate for one card, or null when none applies.
 *
 * Brand matching is the same bidirectional substring match
 * app/api/cardcenter/rates/route.ts performs against brand.name, so 'Best Buy'
 * matches 'best buy ' but not 'BestBuy'. The denomination must match within a
 * cent. A row with no capacity left cannot be sold into, so it is skipped in
 * favour of another matching row rather than failing the card. Among what
 * survives the HIGHEST rate wins, ties broken by the LOWEST id so the choice
 * is stable between runs.
 */
export function pickCurrentRate(
  card: { merchant: string; value: number },
  rates: BuyOrderRate[],
): BuyOrderRate | null {
  const brand = normBrand(card.merchant);
  if (brand === '') return null;
  let best: BuyOrderRate | null = null;
  for (const r of rates) {
    if (r.availableCap <= 0) continue;
    const bn = normBrand(r.brandName);
    if (bn === '' || !(bn.includes(brand) || brand.includes(bn))) continue;
    // Tolerance, not equality: the denominations come from two systems and a
    // cent of float drift must not hide a matching buy order. The 1e-9 slack
    // is float noise, not money -- 50.02 - 50.01 is 0.010000000000005 in
    // binary floating point, which a bare > 0.01 would reject.
    if (Math.abs(r.value - card.value) > 0.01 + 1e-9) continue;
    if (!best || r.rate > best.rate || (r.rate === best.rate && r.id < best.id)) best = r;
  }
  return best;
}

/**
 * Decision for every card in one pass.
 *
 * A card with NO usable rate can still EXPIRE — the deadline does not depend
 * on a rate — but must otherwise WAIT, never SUBMIT, because there would be
 * nothing to submit against.
 */
export function planWaitlistRun(
  cards: WaitlistCardWithBrand[],
  rates: BuyOrderRate[],
  today: string,
): WaitlistPlanEntry[] {
  return cards.map(card => {
    const rate = pickCurrentRate(card, rates);
    const decision = rate
      ? decideWaitlist(card, rate.rate, today)
      : (today > card.maxDate ? 'EXPIRE' : 'WAIT');
    return { card, decision, rate };
  });
}
