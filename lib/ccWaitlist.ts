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
