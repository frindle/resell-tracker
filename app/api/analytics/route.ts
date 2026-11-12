import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { getRange, getPriorYearRange, calcStats, applyLoanCost, PERIOD_LABELS, type PeriodKey } from '@/lib/analytics';
import { loadLoans } from '@/lib/loanData';
import { sumLoanCostCents, loanCostByMonth } from '@/lib/loans';

const PERIODS: PeriodKey[] = [
  'current_month', 'last_month', 'current_quarter', 'last_quarter', 'ytd', 'last_year',
];

const SELECT = {
  salePrice: true, cost: true, shippingCost: true, insuranceCost: true, returnedCost: true, cashbackAmount: true, portalCashback: true, amexOfferDollars: true, amexOfferPoints: true, orderDate: true, platform: true,
  card: { select: { milesProgram: true, basePointsPerDollar: true, merchantRates: { select: { merchant: true, pointsPerDollar: true } } } },
  giftCards: true,
};

// Exclude Card Center orders whose gift cards are ALL unsubmitted (every card
// has ccSubmittedAt null). `some: {}` guards the vacuous-true case so plain
// non-Card-Center orders (no gift cards at all) are NOT dropped; a partially
// submitted order keeps its P&L because not every card is unsubmitted.
const unsubmittedCCFilter = { NOT: { AND: [{ giftCards: { some: {} } }, { giftCards: { every: { ccSubmittedAt: null } } }] } };

export async function GET() {
  try {
  const userId = await getSessionUserId();
  // cancelled must be excluded here the same way the dashboard's month/
  // quarter/YTD queries (app/page.tsx) exclude it — otherwise the two
  // pages sum a different set of orders for the same period and show
  // different P&L numbers for "This Month".
  const userFilter = userId ? { userId, ignoredByRule: false, cancelled: false } : { userId: null, ignoredByRule: false, cancelled: false };
  const now = new Date();
  const loans = await loadLoans(userId);
  const loanCost = (r: { start: Date; end: Date }) => sumLoanCostCents(loans, r.start, r.end, now).totalCents;

  const results = await Promise.all(
    PERIODS.map(async period => {
      const range = getRange(period, now);
      const prior = getPriorYearRange(period, now);

      const [current, comparison] = await Promise.all([
        prisma.order.findMany({ where: { ...userFilter, ...unsubmittedCCFilter, orderDate: { gte: range.start, lte: range.end } }, select: SELECT }),
        prisma.order.findMany({ where: { ...userFilter, ...unsubmittedCCFilter, orderDate: { gte: prior.start, lte: prior.end } }, select: SELECT }),
      ]);

      return {
        period,
        label: PERIOD_LABELS[period],
        range: { start: range.start.toISOString(), end: range.end.toISOString() },
        current: applyLoanCost(calcStats(current), loanCost(range)),
        comparison: applyLoanCost(calcStats(comparison), loanCost(prior)),
      };
    }),
  );

  const monthlyStart = new Date(now.getFullYear() - 2, now.getMonth(), 1);
  const monthlyRows = await prisma.order.findMany({
    where: { ...userFilter, ...unsubmittedCCFilter, orderDate: { gte: monthlyStart } },
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

  // Interest by month, so a month with loan cost but no orders still shows up
  // and each month's profit matches what the period cards subtract.
  const interestByMonth = loanCostByMonth(loans, monthlyStart, now, now);
  const months = [...new Set([...Object.keys(monthlyBuckets), ...Object.keys(interestByMonth)])].sort();
  const monthly = months.map(month => {
    const s = applyLoanCost(calcStats(monthlyBuckets[month] ?? []), interestByMonth[month] ?? 0);
    return { month, revenue: s.revenue, cost: s.cost, cashback: s.cashback, interest: s.loanInterest, profit: s.profit, miles: s.miles, count: s.orderCount };
  });

  return Response.json({ periods: results, monthly });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
