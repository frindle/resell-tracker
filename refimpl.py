#!/usr/bin/env python3
"""Reference impl for: rt-pl-exclude-unsubmitted-cc

The gate applies this, runs the verify, and reverts it. It proves two things at
once: the task is SATISFIABLE as specified, and the verify actually ENFORCES
the spec (a refimpl that goes green while a "Must contain" literal is absent
means the verify is benign).

Change: exclude Card Center orders whose gift cards are ALL unsubmitted
(every GiftCard.ccSubmittedAt is null) from every P&L query in this route,
while keeping non-Card-Center pending orders (they have no giftCards rows and
their cost is real). Two edits to app/api/analytics/route.ts:

  1. SELECT gains `giftCards: true` so the relation filter has its data.
  2. A shared `unsubmittedCCFilter` NOT-clause is spread into every findMany
     where (period current, period comparison, monthly rows).
"""
import pathlib
import sys

wt = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
p = wt / 'app/api/analytics/route.ts'

OLD_SELECT = """const SELECT = {
  salePrice: true, cost: true, shippingCost: true, insuranceCost: true, returnedCost: true, cashbackAmount: true, portalCashback: true, amexOfferDollars: true, amexOfferPoints: true, orderDate: true, platform: true,
"""

NEW_SELECT = """const SELECT = {
  salePrice: true, cost: true, shippingCost: true, insuranceCost: true, returnedCost: true, cashbackAmount: true, portalCashback: true, amexOfferDollars: true, amexOfferPoints: true, orderDate: true, platform: true, giftCards: true,
"""

OLD_FILTER = """  const userFilter = userId ? { userId, ignoredByRule: false, cancelled: false } : { userId: null, ignoredByRule: false, cancelled: false };
"""

NEW_FILTER = """  const userFilter = userId ? { userId, ignoredByRule: false, cancelled: false } : { userId: null, ignoredByRule: false, cancelled: false };
  // Card Center orders whose gift cards are ALL unsubmitted (every
  // GiftCard.ccSubmittedAt is null) have no real cost yet — order 926 was
  // dragging the month P&L on a purchase that never happened. Exclude them
  // here, in every query below. The `some: {}` half is load-bearing: Prisma's
  // `every` is vacuously TRUE over an EMPTY relation, so without it the NOT
  // would also drop every non-Card-Center order (no giftCards rows at all),
  // whose cost is real and must stay in the P&L.
  const unsubmittedCCFilter = { NOT: { AND: [{ giftCards: { some: {} } }, { giftCards: { every: { ccSubmittedAt: null } } }] } };
"""

OLD_PERIOD_QUERY = """        prisma.order.findMany({ where: { ...userFilter, orderDate: { gte: range.start, lte: range.end } }, select: SELECT }),
        prisma.order.findMany({ where: { ...userFilter, orderDate: { gte: prior.start, lte: prior.end } }, select: SELECT }),"""

NEW_PERIOD_QUERY = """        prisma.order.findMany({ where: { ...userFilter, ...unsubmittedCCFilter, orderDate: { gte: range.start, lte: range.end } }, select: SELECT }),
        prisma.order.findMany({ where: { ...userFilter, ...unsubmittedCCFilter, orderDate: { gte: prior.start, lte: prior.end } }, select: SELECT }),"""

OLD_MONTHLY = """    where: { ...userFilter, orderDate: { gte: new Date(now.getFullYear() - 2, now.getMonth(), 1) } },"""
NEW_MONTHLY = """    where: { ...userFilter, ...unsubmittedCCFilter, orderDate: { gte: new Date(now.getFullYear() - 2, now.getMonth(), 1) } },"""


def main():
    if p.exists():
        t = p.read_text()
        for old, new in ((OLD_SELECT, NEW_SELECT), (OLD_FILTER, NEW_FILTER),
                         (OLD_PERIOD_QUERY, NEW_PERIOD_QUERY), (OLD_MONTHLY, NEW_MONTHLY)):
            assert old in t, f"refimpl anchor not found -- did the target change? {old[:60]!r}"
            t = t.replace(old, new, 1)
        p.write_text(t)
    else:
        # Target absent (fresh worktree): emit the complete solution file.
        p.parent.mkdir(parents=True, exist_ok=True)
        base = """import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { getRange, getPriorYearRange, calcStats, PERIOD_LABELS, type PeriodKey } from '@/lib/analytics';

const PERIODS: PeriodKey[] = [
  'current_month', 'last_month', 'current_quarter', 'last_quarter', 'ytd', 'last_year',
];

""" + NEW_SELECT + """  card: { select: { milesProgram: true, basePointsPerDollar: true, merchantRates: { select: { merchant: true, pointsPerDollar: true } } } },
};

export async function GET() {
  try {
  const userId = await getSessionUserId();
""" + NEW_FILTER + """  const now = new Date();

  const results = await Promise.all(
    PERIODS.map(async period => {
      const range = getRange(period, now);
      const prior = getPriorYearRange(period, now);

      const [current, comparison] = await Promise.all([""" + NEW_PERIOD_QUERY + """]);

      return {
        period,
        label: PERIOD_LABELS[period],
        range: { start: range.start.toISOString(), end: range.end.toISOString() },
        current: calcStats(current),
        comparison: calcStats(comparison),
      };
    }),
  );

  const monthlyRows = await prisma.order.findMany({
""" + NEW_MONTHLY + """
    select: SELECT,
    orderBy: { orderDate: 'asc' },
  });

  // Bucket by month and run the SAME calcStats the period cards use. Hand-rolling
  // the sum here is how the chart drifted from the cards — it silently omitted
  // insuranceCost, returnedCost and portalCashback.
  const monthlyBuckets: Record<string, typeof monthlyRows> = {};
  for (const o of monthlyRows) {
    const key = `${o.orderDate.getFullYear()}-${String(o.orderDate.getMonth() + 1).padStart(2, '0')}`;
    (monthlyBuckets[key] ??= []).push(o);
  }

  const monthly = Object.entries(monthlyBuckets)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, rows]) => {
      const s = calcStats(rows);
      return { month, revenue: s.revenue, cost: s.cost, cashback: s.cashback, profit: s.profit, miles: s.miles, count: s.orderCount };
    });

  return Response.json({ periods: results, monthly });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
"""
        p.write_text(base)
    print("refimpl applied")


if __name__ == '__main__':
    main()
