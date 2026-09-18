#!/usr/bin/env python3
"""Reference impl for: cc-waitlist-r2-s4-on

The gate applies this, runs the verify, and reverts it. It proves two things at
once: the task is SATISFIABLE as specified, and the verify actually ENFORCES the
spec (a refimpl that goes green while a "Must contain" literal is absent means
the verify is benign).

Writes the complete solution into lib/ccWaitlist.ts.
"""
import pathlib
import sys

wt = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
p = wt / 'lib/ccWaitlist.ts'
p.parent.mkdir(parents=True, exist_ok=True)

SOLUTION = r'''/**
 * CardCenter waitlist eligibility + dispatch runner.
 *
 * A card is eligible to submit while `today` falls inside its inclusive window
 * [minDate, maxDate] (YYYY-MM-DD strings). The boundary day today == maxDate
 * is STILL eligible -- expiry starts only the next day. Before minDate the
 * card waits; after maxDate it has lapsed and must be surfaced through the
 * injected onExpire hook.
 */

export interface WaitlistCard {
  id: number;
  /** Inclusive start of the window (YYYY-MM-DD); null = no lower bound. */
  minDate: string | null;
  /** Inclusive end of the window (YYYY-MM-DD). */
  maxDate: string;
}

export type WaitlistDecision = 'SUBMIT' | 'WAITING' | 'EXPIRE';

export interface WaitlistError {
  id: number | null;
  message: string;
}

export interface WaitlistSummary {
  submitted: number[];
  waiting: number[];
  expired: number[];
  errors: WaitlistError[];
}

/** Pure decision for one card. today == maxDate is still SUBMIT-eligible. */
export function decideWaitlist(card: WaitlistCard, today: string): WaitlistDecision {
  if (card.maxDate < today) return 'EXPIRE';
  if (card.minDate != null && card.minDate > today) return 'WAITING';
  return 'SUBMIT';
}

export interface WaitlistHooks {
  submit: (card: WaitlistCard) => void | Promise<void>;
  onExpire: (card: WaitlistCard) => void | Promise<void>;
}

/**
 * Iterate candidate cards in order, apply the decision to each, call
 * `hooks.submit` on SUBMIT and `hooks.onExpire` on EXPIRE (WAITING calls
 * neither), and collect a summary. A hook that throws -- or a malformed card
 * missing maxDate -- records one entry in `errors` and the run continues with
 * the next card; it never aborts the batch.
 */
export async function runWaitlist(
  cards: WaitlistCard[],
  today: string,
  hooks: WaitlistHooks,
): Promise<WaitlistSummary> {
  const summary: WaitlistSummary = { submitted: [], waiting: [], expired: [], errors: [] };
  for (const card of cards) {
    try {
      if (!card || typeof card.maxDate !== 'string') throw new Error('invalid waitlist card');
      const decision = decideWaitlist(card, today);
      if (decision === 'SUBMIT') {
        await hooks.submit(card);
        summary.submitted.push(card.id);
      } else if (decision === 'EXPIRE') {
        await hooks.onExpire(card);
        summary.expired.push(card.id);
      } else {
        summary.waiting.push(card.id);
      }
    } catch (err) {
      summary.errors.push({ id: card?.id ?? null, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return summary;
}
'''

p.write_text(SOLUTION)
print("refimpl applied: wrote lib/ccWaitlist.ts")
