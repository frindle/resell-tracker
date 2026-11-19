import type { Prisma } from '@/app/generated/prisma/client';

// Which orders count toward profit and loss. One definition shared by the
// dashboard (app/page.tsx) and /api/analytics, so the two pages can't sum
// different sets of orders for the same period (see commit 52e729d).
//
// Left out:
//  - cancelled orders and orders ignored by a rule;
//  - Card Center orders whose gift cards are ALL unsubmitted (every card has
//    ccSubmittedAt null). Until a card is sent to Card Center its money isn't
//    in play, so it shouldn't count as a loss. `some: {}` keeps plain orders
//    (no gift cards) in. A partly submitted order stays in, and calcStats
//    counts only its submitted share (lib/giftCardShare.ts).
//  - gift card orders still waiting on a MyGiftCardsPlus card link (any link
//    not captured) with no card submitted yet. An uncaptured link has no
//    GiftCard row, so the rule above didn't see the order and its whole cost
//    counted as a loss until the scrape caught up.
const ALL_CARDS_UNSUBMITTED: Prisma.OrderWhereInput = {
  AND: [{ giftCards: { some: {} } }, { giftCards: { every: { ccSubmittedAt: null } } }],
};
const MGCP_CARDS_PENDING: Prisma.OrderWhereInput = {
  AND: [{ mgcpLinks: { some: { status: { not: 'captured' } } } }, { giftCards: { none: { ccSubmittedAt: { not: null } } } }],
};

export const PNL_ORDER_WHERE: Prisma.OrderWhereInput = {
  cancelled: false,
  ignoredByRule: false,
  NOT: { OR: [ALL_CARDS_UNSUBMITTED, MGCP_CARDS_PENDING] },
};

// The same rule as a plain predicate, for tests and in-memory lists.
export function countsTowardPnl(o: {
  cancelled: boolean;
  ignoredByRule: boolean;
  giftCards: { ccSubmittedAt: Date | string | null }[];
  mgcpLinks?: { status: string }[];
}): boolean {
  if (o.cancelled || o.ignoredByRule) return false;
  const noneSubmitted = o.giftCards.every(c => c.ccSubmittedAt == null);
  const allUnsubmitted = o.giftCards.length > 0 && noneSubmitted;
  const mgcpPending = (o.mgcpLinks ?? []).some(l => l.status !== 'captured') && noneSubmitted;
  return !allUnsubmitted && !mgcpPending;
}
