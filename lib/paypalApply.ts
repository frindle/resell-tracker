// What a matched PayPal receipt writes to its order: a note line, and the card
// when the receipt's last four digits point at exactly one of the user's cards.
// Pure, no I/O: lib/emailAutoImport.ts reads the order and cards and saves the result.

import type { PayPalReceipt } from './paypalReceipt.ts';

export type CardRef = { id: number; last4s: readonly string[] };

export type PayPalApplyOrder = { notes: string | null; cardId: number | null; userEditedFields: string | null };

export type PayPalApplyOutcome =
  | 'set'             // the order had no card; it has one now
  | 'replaced'        // the order had another card and nobody edited it; replaced
  | 'kept-user-card'  // the order has another card the user set by hand; only noted
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

function userEdited(order: PayPalApplyOrder, field: string): boolean {
  try {
    const v = JSON.parse(order.userEditedFields ?? '[]');
    return Array.isArray(v) && v.includes(field);
  } catch {
    return false;
  }
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
    } else if (userEdited(order, 'cardId')) {
      outcome = 'kept-user-card';
      lines.push(`PayPal: the card ending ${r.last4} differs from this order's card, which was set by hand; left as it is`);
    } else {
      cardId = card.id;
      outcome = 'replaced';
      lines.push(`PayPal: replaced this order's card with the one ending ${r.last4}, the card PayPal charged`);
    }
  }

  const old = (order.notes ?? '').trimEnd();
  return { notes: old ? `${old}\n${lines.join('\n')}` : lines.join('\n'), cardId, outcome };
}
