import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { getRange, getPriorYearRange, calcStats, PERIOD_LABELS, type PeriodKey } from '@/lib/analytics';

const PERIODS: PeriodKey[] = [
  'current_month', 'last_month', 'current_quarter', 'last_quarter', 'ytd', 'last_year',
];

const SELECT = {
  salePrice: true, cost: true, shippingCost: true, insuranceCost: true, returnedCost: true, cashbackAmount: true, portalCashback: true, orderDate: true, platform: true,
  card: { select: { milesProgram: true, basePointsPerDollar: true, merchantRates: { select: { merchant: true, pointsPerDollar: true } } } },
};

export async function GET() {
  try {
  const userId = await getSessionUserId();
  // cancelled must be excluded here the same way the dashboard's month/
  // quarter/YTD queries (app/page.tsx) exclude it — otherwise the two
  // pages sum a different set of orders for the same period and show
  // different P&L numbers for "This Month".
  const userFilter = userId ? { userId, ignoredByRule: false, cancelled: false } : { userId: null, ignoredByRule: false, cancelled: false };
  const now = new Date();

  const results = await Promise.all(
    PERIODS.map(async period => {
      const range = getRange(period, now);
      const prior = getPriorYearRange(period, now);

      const [current, comparison] = await Promise.all([
        prisma.order.findMany({ where: { ...userFilter, orderDate: { gte: range.start, lte: range.end } }, select: SELECT }),
        prisma.order.findMany({ where: { ...userFilter, orderDate: { gte: prior.start, lte: prior.end } }, select: SELECT }),
      ]);

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
    where: { ...userFilter, orderDate: { gte: new Date(now.getFullYear() - 2, now.getMonth(), 1) } },
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
