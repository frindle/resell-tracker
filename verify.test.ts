// Adversarial repo-style test for: cardBonuses-v2
//
// calculateCardBonus(rule, spend): USER-CONFIGURED bonus -- earn `points` per
// `perDollars` spent, up to `maxTimes` times. No tiers, no defaults.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const ZERO = { times: 0, points: 0 };

async function load() {
  const { calculateCardBonus } = await import('./lib/cardBonuses');
  return calculateCardBonus as (rule: any, spend: any) => { times: number; points: number };
}

test('exact multiples, partial multiples and the cap (spec examples)', async () => {
  const calc = await load();
  const rule = { points: 5, perDollars: 100, maxTimes: 3 };
  assert.deepStrictEqual(calc(rule, 99), { times: 0, points: 0 });
  assert.deepStrictEqual(calc(rule, 99.99), { times: 0, points: 0 });
  assert.deepStrictEqual(calc(rule, 100), { times: 1, points: 5 });
  assert.deepStrictEqual(calc(rule, 199.99), { times: 1, points: 5 });
  assert.deepStrictEqual(calc(rule, 250), { times: 2, points: 10 });
  assert.deepStrictEqual(calc(rule, 300), { times: 3, points: 15 });
  assert.deepStrictEqual(calc(rule, 1000), { times: 3, points: 15 });
});

test('maxTimes omitted or null or undefined means uncapped', async () => {
  const calc = await load();
  assert.deepStrictEqual(calc({ points: 5, perDollars: 100 }, 1000), { times: 10, points: 50 });
  assert.deepStrictEqual(calc({ points: 5, perDollars: 100, maxTimes: null }, 1000), { times: 10, points: 50 });
  assert.deepStrictEqual(calc({ points: 5, perDollars: 100, maxTimes: undefined }, 1000), { times: 10, points: 50 });
});

test('floating point: exact multiples are not under-counted, near misses are not over-counted', async () => {
  const calc = await load();
  assert.deepStrictEqual(calc({ points: 1, perDollars: 0.1 }, 0.3), { times: 3, points: 3 });
  assert.deepStrictEqual(calc({ points: 1, perDollars: 0.01 }, 0.07), { times: 7, points: 7 });
  assert.deepStrictEqual(calc({ points: 2, perDollars: 0.1 }, 0.29), { times: 2, points: 4 });
  assert.deepStrictEqual(calc({ points: 1, perDollars: 0.1 }, 0.7), { times: 7, points: 7 });
});

test('spend 0 and negative spend earn nothing (and never a negative zero)', async () => {
  const calc = await load();
  const rule = { points: 5, perDollars: 100 };
  assert.deepStrictEqual(calc(rule, 0), ZERO);
  assert.deepStrictEqual(calc(rule, -0), ZERO);
  assert.deepStrictEqual(calc(rule, -1), ZERO);
  assert.deepStrictEqual(calc(rule, -1000), ZERO);
  assert.deepStrictEqual(calc(rule, -0.01), ZERO);
});

test('non-finite or non-number spend returns zero without throwing', async () => {
  const calc = await load();
  const rule = { points: 5, perDollars: 100 };
  assert.deepStrictEqual(calc(rule, NaN), ZERO);
  assert.deepStrictEqual(calc(rule, Infinity), ZERO);
  assert.deepStrictEqual(calc(rule, -Infinity), ZERO);
  assert.deepStrictEqual(calc(rule, '500'), ZERO);
  assert.deepStrictEqual(calc(rule, null), ZERO);
  assert.deepStrictEqual(calc(rule, undefined), ZERO);
});

test('missing or non-object rule returns zero without throwing', async () => {
  const calc = await load();
  assert.deepStrictEqual(calc(null, 500), ZERO);
  assert.deepStrictEqual(calc(undefined, 500), ZERO);
  assert.deepStrictEqual(calc({}, 500), ZERO);
});

test('invalid perDollars returns zero', async () => {
  const calc = await load();
  for (const perDollars of [0, -1, -100, NaN, Infinity, -Infinity, '100', null, undefined]) {
    assert.deepStrictEqual(calc({ points: 5, perDollars }, 500), ZERO, 'perDollars=' + String(perDollars));
  }
  assert.deepStrictEqual(calc({ points: 5 }, 500), ZERO);
});

test('invalid points returns zero; points 0 is valid and still counts times', async () => {
  const calc = await load();
  for (const points of [-1, -0.5, NaN, Infinity, -Infinity, '5', null, undefined]) {
    assert.deepStrictEqual(calc({ points, perDollars: 100 }, 1000), ZERO, 'points=' + String(points));
  }
  assert.deepStrictEqual(calc({ perDollars: 100 }, 1000), ZERO);
  assert.deepStrictEqual(calc({ points: 0, perDollars: 100 }, 1000), { times: 10, points: 0 });
});

test('invalid maxTimes returns zero; zero and fractional maxTimes', async () => {
  const calc = await load();
  const rule = { points: 5, perDollars: 100 };
  assert.deepStrictEqual(calc({ ...rule, maxTimes: -1 }, 1000), ZERO);
  assert.deepStrictEqual(calc({ ...rule, maxTimes: -0.5 }, 1000), ZERO);
  assert.deepStrictEqual(calc({ ...rule, maxTimes: NaN }, 1000), ZERO);
  assert.deepStrictEqual(calc({ ...rule, maxTimes: '3' }, 1000), ZERO);
  assert.deepStrictEqual(calc({ ...rule, maxTimes: 0 }, 1000), ZERO);
  assert.deepStrictEqual(calc({ ...rule, maxTimes: 0.9 }, 1000), ZERO);
  assert.deepStrictEqual(calc({ ...rule, maxTimes: 2.9 }, 1000), { times: 2, points: 10 });
  assert.deepStrictEqual(calc({ ...rule, maxTimes: 1 }, 1000), { times: 1, points: 5 });
});

test('never yields Infinity or NaN, even on overflow', async () => {
  const calc = await load();
  assert.deepStrictEqual(calc({ points: 1, perDollars: 0.001 }, 1e308), ZERO);
  assert.deepStrictEqual(calc({ points: 1e200, perDollars: 1 }, 1e200), ZERO);
  const capped = calc({ points: 1, perDollars: 0.001, maxTimes: 3 }, 1e308);
  assert.deepStrictEqual(capped, { times: 3, points: 3 });
});

test('different rules give different results: result comes only from the passed rule', async () => {
  const calc = await load();
  const a = { points: 5, perDollars: 100 };
  const b = { points: 10, perDollars: 50 };
  const c = { points: 1, perDollars: 10 };
  assert.deepStrictEqual(calc(a, 55), { times: 0, points: 0 });
  assert.deepStrictEqual(calc(b, 55), { times: 1, points: 10 });
  assert.deepStrictEqual(calc(c, 55), { times: 5, points: 5 });
  assert.deepStrictEqual(calc(a, 500), { times: 5, points: 25 });
  assert.deepStrictEqual(calc(b, 500), { times: 10, points: 100 });
  assert.deepStrictEqual(calc(c, 500), { times: 50, points: 50 });
  assert.deepStrictEqual(calc({ points: 3, perDollars: 7, maxTimes: 4 }, 100), { times: 4, points: 12 });
});

test('pure: does not mutate the rule and is repeatable', async () => {
  const calc = await load();
  const rule = Object.freeze({ points: 5, perDollars: 100, maxTimes: 3 });
  assert.deepStrictEqual(calc(rule, 250), { times: 2, points: 10 });
  assert.deepStrictEqual(calc(rule, 250), { times: 2, points: 10 });
  assert.deepStrictEqual(rule, { points: 5, perDollars: 100, maxTimes: 3 });
});
