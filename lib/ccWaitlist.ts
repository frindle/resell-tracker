// Waitlist decision + batch runner for credit-card waitlists.
// Dates are YYYY-MM-DD strings compared lexicographically; the window is
// INCLUSIVE on both ends, so today == maxDate (and today == minDate) still submit.

export interface WaitlistCard {
  id?: number | null;
  minDate?: string | null;
  maxDate?: string | null;
}

export type WaitlistDecision = 'SUBMIT' | 'WAITING' | 'EXPIRE';

export interface WaitlistHooks {
  submit: (card: WaitlistCard) => void | Promise<void>;
  onExpire: (card: WaitlistCard) => void | Promise<void>;
}

export interface WaitlistSummary {
  submitted: Array<number | null>;
  waiting: Array<number | null>;
  expired: Array<number | null>;
  errors: Array<{ id: number | null; message: string }>;
}

/**
 * Pure decision for one card. Throws on a malformed card (missing maxDate) so
 * the caller can record it as an error entry instead of guessing a bucket.
 */
export function decideWaitlist(card: WaitlistCard, today: string): WaitlistDecision {
  if (!card || typeof card.maxDate !== 'string') {
    throw new Error('malformed waitlist card: missing maxDate');
  }
  const { minDate, maxDate } = card;
  if (maxDate < today) return 'EXPIRE';
  if (minDate != null && minDate > today) return 'WAITING';
  return 'SUBMIT';
}

const toMessage = (e: unknown): string => e instanceof Error ? e.message : typeof e === 'string' ? e : JSON.stringify(e) ?? String(e);

/**
 * Iterate cards in input order, applying decideWaitlist to each. SUBMIT fires
 * hooks.submit, EXPIRE fires hooks.onExpire (surfaces the lapsed waitlist),
 * WAITING fires neither. A throwing hook or a malformed card records ONE entry
 * in errors for that card and the run continues; it never throws out.
 */
export async function runWaitlist(
  cards: WaitlistCard[],
  today: string,
  hooks: WaitlistHooks,
): Promise<WaitlistSummary> {
  const summary: WaitlistSummary = { submitted: [], waiting: [], expired: [], errors: [] };
  for (const card of cards) {
    try {
      const decision = decideWaitlist(card, today);
      if (decision === 'SUBMIT') {
        await hooks.submit(card);
        summary.submitted.push(card?.id ?? null);
      } else if (decision === 'EXPIRE') {
        await hooks.onExpire(card);
        summary.expired.push(card?.id ?? null);
      } else {
        summary.waiting.push(card?.id ?? null);
      }
    } catch (e) {
      summary.errors.push({ id: card?.id ?? null, message: toMessage(e) });
    }
  }
  return summary;
}
