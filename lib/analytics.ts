export type PeriodKey =
  | 'current_month'
  | 'last_month'
  | 'current_quarter'
  | 'last_quarter'
  | 'ytd'
  | 'last_year';

export type DateRange = { start: Date; end: Date };

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

function endOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}

function quarterStart(d: Date) {
  const q = Math.floor(d.getMonth() / 3);
  return new Date(d.getFullYear(), q * 3, 1);
}

function quarterEnd(d: Date) {
  const q = Math.floor(d.getMonth() / 3);
  return endOfDay(new Date(d.getFullYear(), q * 3 + 3, 0));
}

export function getRange(period: PeriodKey, now = new Date()): DateRange {
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();

  switch (period) {
    case 'current_month':
      return { start: new Date(y, m, 1), end: endOfDay(now) };
    case 'last_month':
      return {
        start: new Date(y, m - 1, 1),
        end: endOfDay(new Date(y, m, 0)),
      };
    case 'current_quarter':
      return { start: quarterStart(now), end: endOfDay(now) };
    case 'last_quarter': {
      const lqStart = new Date(quarterStart(now));
      lqStart.setMonth(lqStart.getMonth() - 3);
      const lqEnd = new Date(quarterStart(now));
      lqEnd.setDate(lqEnd.getDate() - 1);
      return { start: lqStart, end: endOfDay(lqEnd) };
    }
    case 'ytd':
      return { start: new Date(y, 0, 1), end: endOfDay(now) };
    case 'last_year':
      return {
        start: new Date(y - 1, 0, 1),
        end: endOfDay(new Date(y - 1, 11, 31)),
      };
  }
}

// Same calendar window shifted back exactly one year
export function getPriorYearRange(period: PeriodKey, now = new Date()): DateRange {
  const range = getRange(period, now);
  const shift = (d: Date) => new Date(d.getFullYear() - 1, d.getMonth(), d.getDate(),
    d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds());
  return { start: shift(range.start), end: shift(range.end) };
}

export type PeriodStats = {
  revenue: number;
  cost: number;
  cashback: number;
  profit: number;
  orderCount: number;
  miles: number;
  milesByProgram: Record<string, number>;
  // What the points actually cost, in dollars, alongside the points themselves
  // (see centsPerPoint below for the definition and why it is negative more
  // often than not). Summed here rather than divided here on purpose: cost per
  // point is a ratio of totals, not an average of per-order ratios.
  pointCost: number;
  pointCostByProgram: Record<string, number>;
};

export type OrderForStats = {
  salePrice: number | null;
  cost: number;
  shippingCost: number;
  // Must be in the basis because returnedCost is prorated from
  // cost + shipping + insurance — netting it out of a cost that omitted
  // insurance would subtract money this total never added.
  insuranceCost?: number;
  // Cost basis of returned units (lib/orderReturns.ts). salePrice already
  // excludes them, so revenue and cost have to move together.
  returnedCost?: number;
  cashbackAmount: number;
  portalCashback: number | null;
  platform: string;
  card: { milesProgram: string | null; basePointsPerDollar: number | null; merchantRates: { merchant: string; pointsPerDollar: number }[] } | null;
};

export function calcMiles(o: Pick<OrderForStats, 'cost' | 'shippingCost' | 'platform' | 'card'>): number {
  if (!o.card) return 0;
  const rate = o.card.merchantRates.find(r => r.merchant.toLowerCase() === o.platform.toLowerCase())?.pointsPerDollar
    ?? o.card.basePointsPerDollar
    ?? 0;
  return Math.floor((o.cost + o.shippingCost) * rate);
}

/**
 * COST PER POINT — the definition this whole feature hangs on.
 *
 *   cost per point = (what the spend cost, net of everything) / points earned
 *                  = -(profit on that spend) / points earned, in cents
 *
 * i.e. the money actually given up to earn the points, after the resale
 * revenue and after cashback. That is the number a reseller means by "cpp":
 * buy $1,000 of goods on a 2x card, resell for $980, collect $15 cashback, and
 * the 2,000 points cost $5 -- 0.25 cents each.
 *
 * The obvious alternative -- gross spend divided by points -- was rejected
 * because it carries no information at all: it is just the inverse of the
 * card's earn rate, so a 2x card would read 50.00 cents/pt on every order
 * forever, no matter what happened to the order.
 *
 * Consequences of this definition, all deliberate:
 *
 *  - It goes NEGATIVE whenever the spend was profitable, which for a working
 *    reseller is most of the time. Negative means the points were free and
 *    the spend still made money. The page says so rather than clamping it,
 *    because clamping would hide the good case.
 *  - Cashback counts against the cost of the points (both the merchant
 *    cashback and the portal cashback), exactly as it counts toward profit.
 *  - Returns come out of the numerator only. `returnedCost` is netted out of
 *    the cost and `salePrice` already excludes the returned units, so a
 *    returned order contributes close to nothing to the outlay. The points
 *    stay at the full estimated earn, because the denominator here is the
 *    same calcMiles() figure rendered right next to it on the page -- if an
 *    issuer claws points back on a refund, the Miles number is wrong too, and
 *    the fix belongs there, not in a second, quietly different points total.
 *  - Cancelled and ignoredByRule orders are not filtered here at all. They
 *    never reach calcStats: app/api/analytics/route.ts excludes them in the
 *    query, and 52e729d is the commit about what happens when two surfaces
 *    exclude different sets. Everything on the analytics page, cost per point
 *    included, is computed from that one array.
 *  - Orders that earned no points contribute neither cost nor points. Their
 *    spend is not the cost of anything point-shaped, and folding it in would
 *    make a card look expensive because of purchases made on a different one.
 */
export function centsPerPoint(pointCost: number, points: number): number | null {
  if (!points) return null;
  return (pointCost / points) * 100;
}

export function calcStats(orders: OrderForStats[]): PeriodStats {
  return orders.reduce(
    (acc, o) => {
      const sale = o.salePrice ?? 0;
      const netCost = o.cost + o.shippingCost + (o.insuranceCost ?? 0) - (o.returnedCost ?? 0);
      const cashback = o.cashbackAmount + (o.portalCashback ?? 0);
      // Written as the negation of this order's profit contribution rather
      // than re-derived, so the cost-per-point numerator can never drift from
      // the Profit figure shown beside it.
      const orderProfit = sale - netCost + cashback;
      const m = calcMiles(o);
      const program = o.card?.milesProgram ?? null;
      // The totals follow `miles` (every order that earned anything); the
      // per-program buckets follow `milesByProgram` (only orders on a card
      // with a named program). Keeping each numerator on the same footing as
      // the denominator it will be divided by is the whole point.
      const earnedPoints = m > 0;
      // MGCP orders always break even, so their profit/loss is excluded from
      // the cost-per-point numerator (treated as $0) while still counting
      // toward the P&L totals and the points earned.
      const pointCostContribution = o.platform.toLowerCase() === 'mgcp' ? 0 : -orderProfit;
      const milesByProgram: Record<string, number> = { ...acc.milesByProgram };
      const pointCostByProgram: Record<string, number> = { ...acc.pointCostByProgram };
      if (earnedPoints && program) {
        milesByProgram[program] = (milesByProgram[program] ?? 0) + m;
        pointCostByProgram[program] = (pointCostByProgram[program] ?? 0) + pointCostContribution;
      }
      return {
        revenue: acc.revenue + sale,
        cost: acc.cost + netCost,
        cashback: acc.cashback + cashback,
        profit: acc.profit + orderProfit,
        orderCount: acc.orderCount + 1,
        miles: acc.miles + m,
        milesByProgram,
        pointCost: acc.pointCost + (earnedPoints ? pointCostContribution : 0),
        pointCostByProgram,
      };
    },
    { revenue: 0, cost: 0, cashback: 0, profit: 0, orderCount: 0, miles: 0, milesByProgram: {}, pointCost: 0, pointCostByProgram: {} },
  );
}

export const PERIOD_LABELS: Record<PeriodKey, string> = {
  current_month:   'This Month',
  last_month:      'Last Month',
  current_quarter: 'This Quarter',
  last_quarter:    'Last Quarter',
  ytd:             'Year to Date',
  last_year:       'Last Year',
};
