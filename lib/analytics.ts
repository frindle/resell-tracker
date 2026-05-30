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
};

export function calcStats(orders: { salePrice: number | null; cost: number; shippingCost: number; cashbackAmount: number }[]): PeriodStats {
  return orders.reduce(
    (acc, o) => {
      const sale = o.salePrice ?? 0;
      return {
        revenue: acc.revenue + sale,
        cost: acc.cost + o.cost + o.shippingCost,
        cashback: acc.cashback + o.cashbackAmount,
        profit: acc.profit + sale - o.cost - o.shippingCost + o.cashbackAmount,
        orderCount: acc.orderCount + 1,
      };
    },
    { revenue: 0, cost: 0, cashback: 0, profit: 0, orderCount: 0 },
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
