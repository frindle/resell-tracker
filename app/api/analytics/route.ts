import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { getRange, getPriorYearRange, calcStats, PERIOD_LABELS, type PeriodKey } from '@/lib/analytics';

const PERIODS: PeriodKey[] = [
  'current_month', 'last_month', 'current_quarter', 'last_quarter', 'ytd', 'last_year',
];

const SELECT = { salePrice: true, cost: true, shippingCost: true, cashbackAmount: true, orderDate: true };

export async function GET() {
  const userId = await getSessionUserId();
  const userFilter = userId ? { userId } : { userId: null };
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
    where: { ...userFilter, orderDate: { gte: new Date(now.getFullYear() - 1, now.getMonth(), 1) } },
    select: SELECT,
    orderBy: { orderDate: 'asc' },
  });

  const monthlyMap: Record<string, { revenue: number; cost: number; cashback: number; profit: number; count: number }> = {};
  for (const o of monthlyRows) {
    const key = `${o.orderDate.getFullYear()}-${String(o.orderDate.getMonth() + 1).padStart(2, '0')}`;
    if (!monthlyMap[key]) monthlyMap[key] = { revenue: 0, cost: 0, cashback: 0, profit: 0, count: 0 };
    const m = monthlyMap[key];
    const sale = o.salePrice ?? 0;
    m.revenue += sale;
    m.cost += o.cost + o.shippingCost;
    m.cashback += o.cashbackAmount;
    m.profit += sale - o.cost - o.shippingCost + o.cashbackAmount;
    m.count += 1;
  }

  const monthly = Object.entries(monthlyMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, stats]) => ({ month, ...stats }));

  return Response.json({ periods: results, monthly });
}
