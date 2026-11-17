// How much of a gift card order has been sold so far, by face value.
//
// A gift card order's sale price only covers the cards submitted to Card
// Center (each submitted card adds its ccPurchasePrice). Counting the full
// cost against that partial sale shows the unsent cards as a loss: order
// 1039 bought eight $50 cards for $319.96, sent four for $160, and showed a
// -$160 profit. So P&L (calcStats) and the books' cost of goods count only
// the submitted share of the order; the unsent cards are still inventory.
//
// No gift cards: 1 (the whole order counts). No card values: share by count.
export type CardForShare = { value?: number | null; ccSubmittedAt: Date | string | null };

export function submittedShare(cards: readonly CardForShare[] | null | undefined): number {
  if (!cards || cards.length === 0) return 1;
  const face = (c: CardForShare) => (c.value != null && c.value > 0 ? c.value : 0);
  const sent = cards.filter(c => c.ccSubmittedAt != null);
  const total = cards.reduce((t, c) => t + face(c), 0);
  if (total > 0) return sent.reduce((t, c) => t + face(c), 0) / total;
  return sent.length / cards.length;
}
