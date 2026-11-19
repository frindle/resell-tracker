// What a matched PayPal receipt writes to its order: a note line, and the card
// when the order has none and the receipt's last four digits point at exactly one of the user's cards.
// Pure, no I/O: lib/emailAutoImport.ts reads the order and cards and saves the result.

import type { PayPalReceipt } from './paypalReceipt.ts';

export type CardRef = { id: number; last4s: readonly string[] };

export type PayPalApplyOrder = { notes: string | null; cardId: number | null };

export type PayPalApplyOutcome =
  | 'set'             // the order had no card; it has one now
  | 'differs'         // the order has another card; never overwritten, only noted
  | 'same'            // the order already has this card
  | 'no-card';        // no last four, or it matches no card or several

export type PayPalApply = {
  /** The order's notes with the PayPal line(s) added. */
  notes: string;
  /** The card to set, or null to leave the order's card alone. */
  cardId: number | null;
  outcome: PayPalApplyOutcome;
};

/** The cards whose primary or additional last four is `last4`. */
export function cardsWithLast4(cards: readonly CardRef[], last4: string): CardRef[] {
  return cards.filter(c => c.last4s.includes(last4));
}

/** "PayPal: paid with Visa ending 4242 (transaction ABC...)". The transaction id is what marks the receipt as applied. */
export function paypalNoteLine(r: PayPalReceipt): string {
  const how = r.last4 ? `paid with ${r.network ?? 'card'} ending ${r.last4}` : 'paid';
  return `PayPal: ${how} (transaction ${r.txnId})`;
}

export function planPayPalApply(r: PayPalReceipt, order: PayPalApplyOrder, cards: readonly CardRef[]): PayPalApply {
  const lines = [paypalNoteLine(r)];
  let cardId: number | null = null;
  let outcome: PayPalApplyOutcome = 'no-card';

  const found = r.last4 ? cardsWithLast4(cards, r.last4) : [];
  if (found.length === 1) {
    const card = found[0];
    if (order.cardId == null) {
      cardId = card.id;
      outcome = 'set';
    } else if (order.cardId === card.id) {
      outcome = 'same';
    } else {
      // A card is never overwritten, however it got there.
      outcome = 'differs';
      lines.push(`PayPal: the card ending ${r.last4} differs from this order's card; left as it is`);
    }
  }

  const old = (order.notes ?? '').trimEnd();
  return { notes: old ? `${old}\n${lines.join('\n')}` : lines.join('\n'), cardId, outcome };
}
