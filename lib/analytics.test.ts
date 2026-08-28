/**
 * Tests for the analytics roll-up, and specifically for cost per point.
 *
 *   npm run test:analytics
 *
 * No test framework is installed in this repo, so these run on Node's built-in
 * runner with type stripping.
 *
 * The thing worth protecting here is agreement. Cost per point renders inches
 * away from the points and the profit it is derived from, and 52e729d is the
 * commit about what happens when two figures on the same screen are computed
 * over different sets of orders. So these assert the relationships between
 * the numbers, not just each number on its own.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { calcStats, calcMiles, centsPerPoint, type OrderForStats } from './analytics.ts';

const AMEX = {
  milesProgram: 'Amex MR',
  basePointsPerDollar: 2,
  merchantRates: [] as { merchant: string; pointsPerDollar: number }[],
};

function order(over: Partial<OrderForStats> = {}): OrderForStats {
  return {
    salePrice: null,
    cost: 0,
    shippingCost: 0,
    insuranceCost: 0,
    returnedCost: 0,
    cashbackAmount: 0,
    portalCashback: null,
    platform: 'Amazon',
    card: AMEX,
    ...over,
  };
}

test('cost per point is the money given up per point, in cents', () => {
  // $1,000 spend on a 2x card, resold for $980, $15 cashback back.
  // 2,000 points cost $5 -> a quarter of a cent each.
  const s = calcStats([order({ cost: 1000, salePrice: 980, cashbackAmount: 15 })]);
  assert.equal(s.miles, 2000);
  assert.equal(s.pointCost, 5);
  assert.equal(centsPerPoint(s.pointCost, s.miles), 0.25);
});

test('cashback counts against the cost of the points', () => {
  const without = calcStats([order({ cost: 1000, salePrice: 980 })]);
  const with_ = calcStats([order({ cost: 1000, salePrice: 980, cashbackAmount: 15 })]);
  assert.equal(without.pointCost, 20);
  assert.equal(with_.pointCost, 5);
});

test('portal cashback counts the same way merchant cashback does', () => {
  const s = calcStats([order({ cost: 1000, salePrice: 980, cashbackAmount: 5, portalCashback: 10 })]);
  assert.equal(s.pointCost, 5);
});

test('profitable spend gives a negative cost per point — the points were free', () => {
  const s = calcStats([order({ cost: 1000, salePrice: 1030, cashbackAmount: 10 })]);
  assert.equal(s.pointCost, -40);
  assert.equal(centsPerPoint(s.pointCost, s.miles), -2);
});

test('cost per point is a ratio of totals, not an average of per-order ratios', () => {
  // One tiny expensive order and one large cheap one. Averaging the two
  // per-order rates would land nowhere near the real blended cost.
  const s = calcStats([
    order({ cost: 10, salePrice: 0 }),          // 20 pts, $10 outlay
    order({ cost: 1000, salePrice: 1000 }),     // 2,000 pts, $0 outlay
  ]);
  assert.equal(s.miles, 2020);
  assert.equal(s.pointCost, 10);
  assert.equal(centsPerPoint(s.pointCost, s.miles)!.toFixed(4), '0.4950');
});

// --- divide by zero -------------------------------------------------------
test('a card with cost but zero points reports no cost per point, not Infinity', () => {
  assert.equal(centsPerPoint(500, 0), null);
  assert.equal(centsPerPoint(0, 0), null);
  assert.equal(centsPerPoint(-500, 0), null);
});

test('an order that earned nothing contributes no point cost', () => {
  // A card with no earn rate at all: real money out, zero points.
  const noEarn = { milesProgram: 'Amex MR', basePointsPerDollar: 0, merchantRates: [] };
  const s = calcStats([order({ cost: 800, salePrice: 700, card: noEarn })]);
  assert.equal(s.miles, 0);
  assert.equal(s.pointCost, 0);
  assert.deepEqual(s.pointCostByProgram, {});
  assert.equal(s.profit, -100);            // the loss is still real P&L
  assert.equal(centsPerPoint(s.pointCost, s.miles), null);
});

test('spend on no card at all is not charged to some other card', () => {
  const s = calcStats([
    order({ cost: 1000, salePrice: 990, card: null }),
    order({ cost: 100, salePrice: 100 }),
  ]);
  assert.equal(s.pointCostByProgram['Amex MR'], 0);
  assert.equal(s.milesByProgram['Amex MR'], 200);
  assert.equal(s.profit, -10);
});

// --- MGCP -----------------------------------------------------------------
test('an MGCP order contributes no point cost, but its P&L and points are real', () => {
  // MGCP always breaks even, so its loss is excluded from the cost-per-point
  // numerator while still counting as real P&L and real points.
  const s = calcStats([order({ cost: 1000, salePrice: 980, platform: 'MGCP' })]);
  assert.equal(s.miles, 2000);
  assert.equal(s.milesByProgram['Amex MR'], 2000);
  assert.equal(s.pointCost, 0);
  assert.equal(s.pointCostByProgram['Amex MR'], 0);
  assert.equal(s.revenue, 980);
  assert.equal(s.cost, 1000);
  assert.equal(s.profit, -20);
});

// --- returns --------------------------------------------------------------
test('a returned order costs almost nothing but keeps the points it was shown earning', () => {
  // $500 order, fully returned: returnedCost cancels the cost and salePrice
  // already excludes the returned unit. The points stay at the estimated
  // earn, because that is the same figure rendered beside the cost per point.
  const returned = order({ cost: 500, returnedCost: 500, salePrice: null });
  assert.equal(calcMiles(returned), 1000);

  const s = calcStats([returned]);
  assert.equal(s.cost, 0);
  assert.equal(s.miles, 1000);
  assert.equal(s.pointCost, 0);
  assert.equal(centsPerPoint(s.pointCost, s.miles), 0);
});

test('a partial return moves cost and revenue together', () => {
  const s = calcStats([order({ cost: 500, returnedCost: 200, salePrice: 310 })]);
  assert.equal(s.cost, 300);
  assert.equal(s.profit, 10);
  assert.equal(s.miles, 1000);              // earn is on the original spend
  assert.equal(s.pointCost, -10);
});

// --- agreement with what is rendered beside it ----------------------------
test('point cost is exactly the negated profit when every order earned points', () => {
  const orders = [
    order({ cost: 1000, salePrice: 980, cashbackAmount: 15 }),
    order({ cost: 250, shippingCost: 12, insuranceCost: 3, salePrice: 300, portalCashback: 4 }),
    order({ cost: 500, returnedCost: 200, salePrice: 310 }),
  ];
  const s = calcStats(orders);
  assert.equal(s.pointCost.toFixed(2), (-s.profit).toFixed(2));
});

test('the per-program buckets add up to the total when every card names a program', () => {
  const alaska = { milesProgram: 'Alaska', basePointsPerDollar: 1, merchantRates: [] };
  const s = calcStats([
    order({ cost: 1000, salePrice: 980 }),
    order({ cost: 400, salePrice: 420, card: alaska }),
  ]);
  const summed = Object.values(s.pointCostByProgram).reduce((a, b) => a + b, 0);
  assert.equal(summed, s.pointCost);
  assert.equal(Object.values(s.milesByProgram).reduce((a, b) => a + b, 0), s.miles);
  assert.equal(s.pointCostByProgram['Amex MR'], 20);
  assert.equal(s.pointCostByProgram['Alaska'], -20);
});

test('a merchant-specific rate drives the points, and so the cost per point', () => {
  const card = { milesProgram: 'Amex MR', basePointsPerDollar: 1, merchantRates: [{ merchant: 'amazon', pointsPerDollar: 5 }] };
  const s = calcStats([order({ cost: 200, salePrice: 190, platform: 'Amazon', card })]);
  assert.equal(s.miles, 1000);
  assert.equal(centsPerPoint(s.pointCost, s.miles), 1);
});

test('an empty period is all zeroes and no cost per point', () => {
  const s = calcStats([]);
  assert.equal(s.pointCost, 0);
  assert.equal(s.miles, 0);
  assert.deepEqual(s.pointCostByProgram, {});
  assert.equal(centsPerPoint(s.pointCost, s.miles), null);
});
