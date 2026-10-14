// Adversarial repo-style test for: cardBonuses-v2
//
// Tests the new calculateCardBonus(rule, spend) API.
// Import the target the way the repo does:
//   import { calculateCardBonus } from './lib/cardBonuses';

import { test } from 'node:test';
import assert from 'node:assert/strict';

test('happy path: exact multiples with maxTimes', async () => {
  const { calculateCardBonus } = await import('./lib/cardBonuses');
  const rule = { points: 5, perDollars: 100, maxTimes: 3 };

  // spend 99 -> 0 times, 0 points
  assert.deepStrictEqual(calculateCardBonus(rule, 99), { times: 0, points: 0 });

  // spend 100 -> 1 time, 5 points
  assert.deepStrictEqual(calculateCardBonus(rule, 100), { times: 1, points: 5 });

  // spend 250 -> 2 times, 10 points
  assert.deepStrictEqual(calculateCardBonus(rule, 250), { times: 2, points: 10 });

  // spend 1000 -> 3 times (capped), 15 points
  assert.deepStrictEqual(calculateCardBonus(rule, 1000), { times: 3, points: 15 });
});

test('no maxTimes: unlimited', async () => {
  const { calculateCardBonus } = await import('./lib/cardBonuses');
  const rule = { points: 5, perDollars: 100 };

  // spend 1000 -> 10 times, 50 points
  assert.deepStrictEqual(calculateCardBonus(rule, 1000), { times: 10, points: 50 });
});

test('maxTimes null: unlimited', async () => {
  const { calculateCardBonus } = await import('./lib/cardBonuses');
  const rule = { points: 5, perDollars: 100, maxTimes: null };

  assert.deepStrictEqual(calculateCardBonus(rule, 1000), { times: 10, points: 50 });
});

test('floating-point precision: perDollars 0.1, spend 0.3 -> 3 times', async () => {
  const { calculateCardBonus } = await import('./lib/cardBonuses');
  const rule = { points: 1, perDollars: 0.1 };

  assert.deepStrictEqual(calculateCardBonus(rule, 0.3), { times: 3, points: 3 });
});

test('floating-point precision: perDollars 0.01, spend 0.07 -> 7 times', async () => {
  const { calculateCardBonus } = await import('./lib/cardBonuses');
  const rule = { points: 1, perDollars: 0.01 };

  assert.deepStrictEqual(calculateCardBonus(rule, 0.07), { times: 7, points: 7 });
});

test('invalid spend: negative/NaN/Infinity -> 0/0', async () => {
  const { calculateCardBonus } = await import('./lib/cardBonuses');
  const rule = { points: 5, perDollars: 100 };

  assert.deepStrictEqual(calculateCardBonus(rule, -1), { times: 0, points: 0 });
  assert.deepStrictEqual(calculateCardBonus(rule, NaN), { times: 0, points: 0 });
  assert.deepStrictEqual(calculateCardBonus(rule, Infinity), { times: 0, points: 0 });
  assert.deepStrictEqual(calculateCardBonus(rule, -Infinity), { times: 0, points: 0 });
});

test('invalid rule: perDollars <= 0/NaN/non-finite -> 0/0', async () => {
  const { calculateCardBonus } = await import('./lib/cardBonuses');

  assert.deepStrictEqual(calculateCardBonus({ points: 5, perDollars: 0 }, 100), { times: 0, points: 0 });
  assert.deepStrictEqual(calculateCardBonus({ points: 5, perDollars: -1 }, 100), { times: 0, points: 0 });
  assert.deepStrictEqual(calculateCardBonus({ points: 5, perDollars: NaN }, 100), { times: 0, points: 0 });
  assert.deepStrictEqual(calculateCardBonus({ points: 5, perDollars: Infinity }, 100), { times: 0, points: 0 });
});

test('invalid rule: points negative/NaN -> 0/0', async () => {
  const { calculateCardBonus } = await import('./lib/cardBonuses');

  assert.deepStrictEqual(calculateCardBonus({ points: -1, perDollars: 100 }, 100), { times: 0, points: 0 });
  assert.deepStrictEqual(calculateCardBonus({ points: NaN, perDollars: 100 }, 100), { times: 0, points: 0 });
});

test('invalid maxTimes: < 0 or NaN -> 0/0', async () => {
  const { calculateCardBonus } = await import('./lib/cardBonuses');
  const rule = { points: 5, perDollars: 100 };

  assert.deepStrictEqual(calculateCardBonus({ ...rule, maxTimes: -1 }, 100), { times: 0, points: 0 });
  assert.deepStrictEqual(calculateCardBonus({ ...rule, maxTimes: NaN }, 100), { times: 0, points: 0 });
});

test('maxTimes 0 -> 0 times', async () => {
  const { calculateCardBonus } = await import('./lib/cardBonuses');
  const rule = { points: 5, perDollars: 100, maxTimes: 0 };

  assert.deepStrictEqual(calculateCardBonus(rule, 1000), { times: 0, points: 0 });
});

test('fractional maxTimes floored', async () => {
  const { calculateCardBonus } = await import('./lib/cardBonuses');
  const rule = { points: 5, perDollars: 100, maxTimes: 2.9 };

  assert.deepStrictEqual(calculateCardBonus(rule, 1000), { times: 2, points: 10 });
});

test('different rules give different results (no tier table)', async () => {
  const { calculateCardBonus } = await import('./lib/cardBonuses');
  const ruleA = { points: 5, perDollars: 100 };
  const ruleB = { points: 10, perDollars: 50 };

  const resultA = calculateCardBonus(ruleA, 500);
  const resultB = calculateCardBonus(ruleB, 500);

  assert.notStrictEqual(resultA, resultB);
  assert.deepStrictEqual(resultA, { times: 5, points: 25 });
  assert.deepStrictEqual(resultB, { times: 10, points: 100 });
});

test('over-trigger guard: no maxTimes or maxTimes null -> same result', async () => {
  const { calculateCardBonus } = await import('./lib/cardBonuses');
  const ruleNoMax = { points: 5, perDollars: 100 };
  const ruleNullMax = { points: 5, perDollars: 100, maxTimes: null };

  const resultNoMax = calculateCardBonus(ruleNoMax, 1000);
  const resultNullMax = calculateCardBonus(ruleNullMax, 1000);

  assert.deepStrictEqual(resultNoMax, resultNullMax);
  assert.deepStrictEqual(resultNoMax, { times: 10, points: 50 });
});
