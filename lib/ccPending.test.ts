import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalGiftBrand } from './giftBrand.ts';
import { groupByBrand, pickUnderPayout } from './ccPending.ts';

test('Uber and Uber Eats are one brand; other names pass through trimmed', () => {
  for (const n of ['Uber', 'uber', ' UBER EATS ', 'Uber Eats', 'UberEats', 'Uber Gift Card', 'Uber Eats GC', 'uber  eats egift']) {
    assert.equal(canonicalGiftBrand(n), 'Uber Eats', n);
  }
  assert.equal(canonicalGiftBrand(' DoorDash '), 'DoorDash');
  assert.equal(canonicalGiftBrand('Uberstore'), 'Uberstore');
  assert.equal(canonicalGiftBrand('Best  Buy'), 'Best Buy');
});

test('groupByBrand merges aliases, sorts brands and cards, and totals', () => {
  const g = groupByBrand([
    { id: 3, merchant: 'Uber', value: 100, currentRate: 0.85 },
    { id: 1, merchant: 'Uber Eats', value: 50, currentRate: 0.86 },
    { id: 2, merchant: 'DoorDash', value: 25, currentRate: null },
  ]);
  assert.deepEqual(g.map(x => x.brand), ['DoorDash', 'Uber Eats']);
  const uber = g[1];
  assert.deepEqual(uber.cards.map(c => c.id), [1, 3]);
  assert.equal(uber.count, 2);
  assert.equal(uber.face, 150);
  assert.equal(uber.payoutNow, 128);
  assert.equal(uber.bestRate, 0.86);
  assert.equal(g[0].bestRate, null);
  assert.equal(g[0].payoutNow, 0);
});

test('pickUnderPayout takes oldest first, skips a card that would pass the cap, keeps smaller ones', () => {
  const cards = [
    { id: 5, value: 25 },
    { id: 1, value: 100 },
    { id: 2, value: 100 },
    { id: 3, value: 200 },
  ];
  // 85%: 85 + 85 = 170; +170 (id 3) would pass 250; id 5 adds 21.25.
  const p = pickUnderPayout(cards, 0.85, 250);
  assert.deepEqual(p.take, [1, 2, 5]);
  assert.deepEqual(p.left, [3]);
  assert.equal(p.payout, 191.25);
});

test('pickUnderPayout: exact fit is taken, null cap takes all', () => {
  assert.deepEqual(pickUnderPayout([{ id: 1, value: 100 }], 0.85, 85).take, [1]);
  const all = pickUnderPayout([{ id: 2, value: 10 }, { id: 1, value: 10 }], 0.9, null);
  assert.deepEqual(all.take, [1, 2]);
  assert.equal(all.payout, 18);
});
