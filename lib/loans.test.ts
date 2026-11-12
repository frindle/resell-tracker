/**
 * Loan math and the loan-interest effect on profit.
 *
 *   node --experimental-strip-types --test lib/loans.test.ts
 *
 * Expected schedule figures were computed independently with a decimal
 * (half-up) amortization calculator, not by this code:
 *   $10,000 at 6% for 12 months -> $860.66 payment, $50.00 first-month interest.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSchedule, summarizeLoan, sumLoanCostCents, loanCostByMonth, monthlyPaymentCents, toCents,
  type LoanLite, type LoanEntryLite,
} from './loans.ts';
import { calcStats, applyLoanCost, type OrderForStats } from './analytics.ts';

const d = (y: number, m: number, day: number) => new Date(y, m - 1, day, 12);

function inst(over: Partial<LoanLite> = {}): LoanLite {
  return {
    kind: 'installment', principalCents: 1000000, aprPercent: 6, termMonths: 12,
    startDate: null, firstPaymentDate: d(2026, 2, 15), originationFeeCents: 0, entries: [], ...over,
  };
}
function entry(over: Partial<LoanEntryLite>): LoanEntryLite {
  return { kind: 'statement', postedAt: d(2026, 11, 30), interestCents: 0, feeCents: 0, principalCents: 0, balanceCents: null, periodIndex: null, ...over };
}

test('monthly payment matches a standard calculator', () => {
  assert.equal(monthlyPaymentCents(1000000, 6, 12), 86066);
  assert.equal(monthlyPaymentCents(500000, 12, 24), 23537);
  assert.equal(monthlyPaymentCents(120000, 0, 12), 10000);
});

test('normal month: every row to the cent, last payment absorbs rounding', () => {
  const rows = buildSchedule(inst());
  const expected: [number, number, number][] = [
    [5000, 81066, 918934], [4595, 81471, 837463], [4187, 81879, 755584], [3778, 82288, 673296],
    [3366, 82700, 590596], [2953, 83113, 507483], [2537, 83529, 423954], [2120, 83946, 340008],
    [1700, 84366, 255642], [1278, 84788, 170854], [854, 85212, 85642], [428, 85642, 0],
  ];
  assert.equal(rows.length, 12);
  rows.forEach((r, i) => {
    assert.deepEqual([r.interestCents, r.principalCents, r.balanceCents], expected[i], `row ${i + 1}`);
    assert.equal(r.paymentCents, r.interestCents + r.principalCents);
  });
  // regular payment 860.66; the last one is 860.70 -- the 4 cents of rounding
  assert.equal(rows[0].paymentCents, 86066);
  assert.equal(rows[11].paymentCents, 86070);
  assert.equal(rows.reduce((s, r) => s + r.principalCents, 0), 1000000);
  assert.equal(rows[0].date.getTime(), d(2026, 2, 15).getTime());
  assert.equal(rows[11].date.getTime(), d(2027, 1, 15).getTime());
});

test('short first month uses actual days / 365 for the first interest', () => {
  // funded Jan 20, first payment Feb 15 = 26 days: 5000 * 12% * 26/365 = 42.74
  const rows = buildSchedule(inst({
    principalCents: 500000, aprPercent: 12, termMonths: 24, startDate: d(2026, 1, 20), firstPaymentDate: d(2026, 2, 15),
  }));
  assert.deepEqual([rows[0].interestCents, rows[0].principalCents, rows[0].balanceCents], [4274, 19263, 480737]);
  assert.deepEqual([rows[1].interestCents, rows[1].principalCents, rows[1].balanceCents], [4807, 18730, 462007]);
  assert.equal(rows.length, 24);
  assert.equal(rows[23].balanceCents, 0);
});

test('payment dates clamp to month end and come back', () => {
  const rows = buildSchedule(inst({ firstPaymentDate: d(2026, 1, 31), termMonths: 3 }));
  assert.deepEqual(rows.map(r => r.date.getDate()), [31, 28, 31]);
});

test('extra payment shortens the schedule and the payoff date moves up', () => {
  const loan = inst({ entries: [entry({ kind: 'extra_payment', postedAt: d(2026, 4, 15), principalCents: 200000, id: 7 })] });
  const rows = buildSchedule(loan);
  const extra = rows.find(r => r.type === 'extra')!;
  assert.equal(extra.balanceCents, 555584); // 755,584 after payment 3 less 2,000.00
  assert.equal(extra.entryId, 7);
  const pays = rows.filter(r => r.type === 'payment');
  assert.equal(pays.length, 10);
  assert.deepEqual([pays[3].interestCents, pays[3].principalCents, pays[3].balanceCents], [2778, 83288, 472296]);
  assert.deepEqual([pays[9].interestCents, pays[9].principalCents, pays[9].balanceCents], [248, 49567, 0]);
  assert.equal(summarizeLoan(loan, d(2026, 6, 1)).payoffDate!.getTime(), d(2026, 11, 15).getTime());
  assert.equal(summarizeLoan(inst(), d(2026, 6, 1)).payoffDate!.getTime(), d(2027, 1, 15).getTime());
});

test('payoff: balance reaches exactly zero and later payments disappear', () => {
  const loan = inst({ entries: [entry({ kind: 'extra_payment', postedAt: d(2026, 3, 20), principalCents: 5000000 })] });
  const rows = buildSchedule(loan);
  assert.equal(rows[rows.length - 1].balanceCents, 0);
  assert.equal(rows.filter(r => r.type === 'payment').length, 2);
  assert.equal(rows.find(r => r.type === 'extra')!.principalCents, 837463); // capped at what is owed after payment 2
});

test('a recorded payment replaces the scheduled one and the rest continues from it', () => {
  const loan = inst({ entries: [entry({ kind: 'payment', periodIndex: 2, postedAt: d(2026, 3, 1), interestCents: 5000, feeCents: 2500, principalCents: 80000 })] });
  const rows = buildSchedule(loan);
  assert.equal(rows[1].recorded, true);
  assert.equal(rows[1].date.getTime(), d(2026, 3, 1).getTime());
  assert.equal(rows[1].balanceCents, 918934 - 80000);
  assert.equal(rows[2].interestCents, Math.round(838934 * 0.005));
});

test('statement interest for a line and a card lands in the right month', () => {
  const entries = [
    entry({ postedAt: d(2026, 10, 31), interestCents: 1234, balanceCents: 100000 }),
    entry({ postedAt: d(2026, 11, 30), interestCents: 2000, feeCents: 500, balanceCents: 90000 }),
    entry({ postedAt: d(2026, 12, 1), interestCents: 999, balanceCents: 80000 }),
  ];
  const nov = [new Date(2026, 10, 1), new Date(2026, 10, 30, 23, 59, 59, 999)] as const;
  const asOf = d(2027, 1, 1);
  for (const kind of ['line', 'card']) {
    const loan: LoanLite = { kind, principalCents: 0, aprPercent: null, termMonths: null, startDate: null, firstPaymentDate: null, originationFeeCents: 0, entries };
    const r = sumLoanCostCents([loan], nov[0], nov[1], asOf);
    assert.deepEqual([r.interestCents, r.feeCents, r.totalCents], [2000, 500, 2500], kind);
    assert.deepEqual(loanCostByMonth([loan], new Date(2026, 9, 1), asOf, asOf), { '2026-10': 1234, '2026-11': 2500, '2026-12': 999 });
    assert.equal(summarizeLoan(loan, asOf).balanceCents, 80000);
    // a $0 statement is a normal month
    assert.equal(sumLoanCostCents([{ ...loan, entries: [entry({ postedAt: d(2026, 11, 30) })] }], nov[0], nov[1], asOf).totalCents, 0);
  }
});

test('installment interest and fees post on their dates, never in the future', () => {
  const loan = inst({ originationFeeCents: 10000, entries: [entry({ kind: 'fee', postedAt: d(2026, 3, 2), feeCents: 3500 })] });
  // funded Jan 15 (fee 100.00); payments Feb 15 (50.00) and Mar 15 (45.95); late fee Mar 2 (35.00)
  const upToMar20 = sumLoanCostCents([loan], null, d(2026, 3, 20), d(2026, 3, 20));
  assert.deepEqual([upToMar20.interestCents, upToMar20.feeCents], [5000 + 4595, 10000 + 3500]);
  const feb = sumLoanCostCents([loan], new Date(2026, 1, 1), new Date(2026, 1, 28, 23, 59), d(2026, 12, 1));
  assert.deepEqual([feb.interestCents, feb.feeCents], [5000, 0]);
  // asOf caps a window that reaches into the future
  assert.equal(sumLoanCostCents([loan], null, d(2030, 1, 1), d(2026, 2, 16)).interestCents, 5000);
  assert.equal(summarizeLoan(loan, d(2026, 2, 16)).balanceCents, 918934);
});

test('toCents rounds dollars safely', () => {
  assert.equal(toCents(19.99), 1999);
  assert.equal(toCents('1,234.5'), 123450);
  assert.equal(toCents(1.005), 101);
  assert.equal(toCents('abc'), null);
});

function order(over: Partial<OrderForStats>): OrderForStats {
  return {
    salePrice: 100, cost: 60, shippingCost: 0, cashbackAmount: 5, portalCashback: null,
    amexOfferDollars: null, amexOfferPoints: null, platform: 'Amazon', card: null, ...over,
  };
}

test('period profit with and without loan interest', () => {
  const base = calcStats([order({}), order({ salePrice: 50, cost: 40, cashbackAmount: 0 })]);
  assert.equal(base.profit, 45 + 10);
  assert.equal(base.loanInterest, 0);
  assert.equal(applyLoanCost(base, 0).profit, 55);
  const withInterest = applyLoanCost(base, 1234);
  assert.ok(Math.abs(withInterest.profit - (55 - 12.34)) < 1e-9);
  assert.equal(withInterest.loanInterest, 12.34);
  // revenue / cost / cashback are untouched: interest is not an order cost
  assert.equal(withInterest.revenue, base.revenue);
  assert.equal(withInterest.cost, base.cost);
  assert.equal(withInterest.cashback, base.cashback);
});

test('home page and Analytics agree: monthly profits sum to the period profit', () => {
  const loan: LoanLite = {
    kind: 'line', principalCents: 0, aprPercent: null, termMonths: null, startDate: null, firstPaymentDate: null, originationFeeCents: 0,
    entries: [entry({ postedAt: d(2026, 10, 31), interestCents: 1500 }), entry({ postedAt: d(2026, 11, 30), interestCents: 2250, feeCents: 300 })],
  };
  const now = d(2026, 11, 30);
  const octOrders = [order({})], novOrders = [order({ salePrice: 200, cost: 120 })];
  // Home page / period card: one window, one subtraction.
  const ytdStart = new Date(2026, 0, 1);
  const period = applyLoanCost(calcStats([...octOrders, ...novOrders]), sumLoanCostCents([loan], ytdStart, now, now).totalCents);
  // Analytics monthly table: per-month subtraction.
  const byMonth = loanCostByMonth([loan], ytdStart, now, now);
  const oct = applyLoanCost(calcStats(octOrders), byMonth['2026-10'] ?? 0);
  const nov = applyLoanCost(calcStats(novOrders), byMonth['2026-11'] ?? 0);
  assert.ok(Math.abs(oct.profit + nov.profit - period.profit) < 1e-9);
  assert.ok(Math.abs(oct.loanInterest + nov.loanInterest - period.loanInterest) < 1e-9);
  assert.equal(period.loanInterest, 40.5);
});
