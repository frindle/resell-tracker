// "Processed" display status for CardCenter orders.
//
// An order whose gift cards have ALL been submitted to CardCenter is
// "Processed" on the Orders page instead of "Pending" -- the cards are out
// of our hands and we are only waiting for CardCenter to pay.
//
// Purely derived, never persisted: nothing is written to the order row. The
// notion of "submitted" is the codebase's existing one -- GiftCard.ccSubmittedAt
// is set (components/GiftCards.tsx `allSubmitted`, the order-row "unsubmitted
// cards" warning, and the analytics unsubmittedCCFilter all use it).
//
// Only the payment-status 'pending' bucket is relabelled. paymentStatus()
// itself (lib/paymentStatus.ts) is untouched on purpose, so the Pending
// filter / count, outstanding total, overdue logic and dashboard owed
// figures keep treating these orders as unpaid, exactly as they already do
// for orders that read "Processed" because of bgCredited / bfmrStatus.

export type PaymentStatus = 'lost' | 'paid' | 'partial' | 'overdue' | 'pending' | 'none';
export type DisplayPaymentStatus = PaymentStatus | 'processed';

export type GiftCardSubmission = { ccSubmittedAt: string | Date | null };

/** True when the order has at least one gift card and every one is submitted. */
export function allGiftCardsSubmitted(giftCards: readonly GiftCardSubmission[] | null | undefined): boolean {
  return !!giftCards && giftCards.length > 0 && giftCards.every(c => !!c.ccSubmittedAt);
}

/**
 * The status to display for an order given its payment status.
 *
 * 'pending' becomes 'processed' iff all gift cards are submitted (>= 1 card)
 * and the order is neither cancelled nor lost. Every other status (paid,
 * partial, overdue, lost, none) is returned unchanged.
 */
export function displayPaymentStatus(
  ps: PaymentStatus,
  o: { cancelled: boolean; lost: boolean; giftCards?: readonly GiftCardSubmission[] | null },
): DisplayPaymentStatus {
  if (o.cancelled || o.lost) return ps;
  if (ps !== 'pending') return ps;
  return allGiftCardsSubmitted(o.giftCards) ? 'processed' : ps;
}
