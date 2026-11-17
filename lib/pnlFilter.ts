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
//    (no gift cards) in; a partly submitted order stays in.
export const PNL_ORDER_WHERE: Prisma.OrderWhereInput = {
  cancelled: false,
  ignoredByRule: false,
  NOT: { AND: [{ giftCards: { some: {} } }, { giftCards: { every: { ccSubmittedAt: null } } }] },
};

// The same rule as a plain predicate, for tests and in-memory lists.
export function countsTowardPnl(o: { cancelled: boolean; ignoredByRule: boolean; giftCards: { ccSubmittedAt: Date | string | null }[] }): boolean {
  if (o.cancelled || o.ignoredByRule) return false;
  const allUnsubmitted = o.giftCards.length > 0 && o.giftCards.every(c => c.ccSubmittedAt == null);
  return !allUnsubmitted;
}
