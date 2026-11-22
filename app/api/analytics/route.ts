import { PNL_ORDER_WHERE } from '@/lib/pnlFilter';
import { prisma } from '@/lib/db';
import { getSessionUserId } from '@/lib/auth';
import { getRange, getPriorYearRange, calcStats, applyLoanCost, PERIOD_LABELS, type PeriodKey } from '@/lib/analytics';
import { loadLoans } from '@/lib/loanData';
import { sumLoanCostCents, loanCostByMonth } from '@/lib/loans';
import { bloomInRange, withBloomMonthly } from '@/lib/bloomInvoice';
import { loadInvoiceMoneyToDate } from '@/lib/bloomInvoiceService';

const PERIODS: PeriodKey[] = [
  'current_month', 'last_month', 'current_quarter', 'last_quarter', 'ytd', 'last_year',
];

const SELECT = {
  salePrice: true, cost: true, shippingCost: true, insuranceCost: true, returnedCost: true, cashbackAmount: true, portalCashback: true, amexOfferDollars: true, amexOfferPoints: true, orderDate: true, platform: true,
  card: { select: { milesProgram: true, basePointsPerDollar: true, rateHistory: { select: { effectiveFrom: true, rewardsRate: true, basePointsPerDollar: true } }, merchantRates: { select: { merchant: true, pointsPerDollar: true } } } },
  giftCards: true,
};


export async function GET() {
  try {
  const userId = await getSessionUserId();
  // Which orders count (cancelled, ignored, all-unsubmitted Card Center) is
  // PNL_ORDER_WHERE, shared with the dashboard so the two pages agree.
  const userFilter = userId ? { userId } : { userId: null };
  const now = new Date();
  const loans = await loadLoans(userId);
  // Bloom Ledger side hustle: monthly invoices plus the month still running, to date, read live from the ledger (none, or
  // signed out, means every Bloom figure is zero).
  const invoices = await loadInvoiceMoneyToDate(userId);
  const loanCost = (r: { start: Date; end: Date }) => sumLoanCostCents(loans, r.start, r.end, now).totalCents;

  const results = await Promise.all(
    PERIODS.map(async period => {
      const range = getRange(period, now);
      const prior = getPriorYearRange(period, now);

      const [current, comparison] = await Promise.all([
        prisma.order.findMany({ where: { ...userFilter, ...PNL_ORDER_WHERE, orderDate: { gte: range.start, lte: range.end } }, select: SELECT }),
        prisma.order.findMany({ where: { ...userFilter, ...PNL_ORDER_WHERE, orderDate: { gte: prior.start, lte: prior.end } }, select: SELECT }),
      ]);

      return {
        period,
        label: PERIOD_LABELS[period],
        range: { start: range.start.toISOString(), end: range.end.toISOString() },
        current: applyLoanCost(calcStats(current), loanCost(range)),
        comparison: applyLoanCost(calcStats(comparison), loanCost(prior)),
        bloom: { current: bloomInRange(invoices, range.start, range.end), comparison: bloomInRange(invoices, prior.start, prior.end) },
      };
    }),
  );

  const monthlyStart = new Date(now.getFullYear() - 2, now.getMonth(), 1);
  const monthlyRows = await prisma.order.findMany({
    where: { ...userFilter, ...PNL_ORDER_WHERE, orderDate: { gte: monthlyStart } },
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
  const resellMonthly = months.map(month => {
    const s = applyLoanCost(calcStats(monthlyBuckets[month] ?? []), interestByMonth[month] ?? 0);
    return { month, revenue: s.revenue, cost: s.cost, cashback: s.cashback, interest: s.loanInterest, profit: s.profit, miles: s.miles, count: s.orderCount };
  });
  // Each row keeps its reselling figures and gains bloomGross / bloomCost / bloomNet and combined (reselling + Bloom).
  const monthly = withBloomMonthly(resellMonthly, invoices, month => ({ month, revenue: 0, cost: 0, cashback: 0, interest: 0, profit: 0, miles: 0, count: 0 }));

  return Response.json({ periods: results, monthly, bloomInvoiceCount: invoices.length });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
