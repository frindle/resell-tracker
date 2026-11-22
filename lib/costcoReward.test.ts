import { test } from 'node:test';
import assert from 'node:assert/strict';
import { costcoReward, costcoRewardBase, parseRewardRate, isCostco, cleanSubtotal, COSTCO_REWARD_DEFAULT_RATE } from './costcoReward.ts';

const o = { platform: 'Costco', cost: 1082.5 };

test('2% of the purchase price in the tracker', () => {
  assert.equal(costcoReward(o, 2), 21.65);
  assert.equal(costcoRewardBase(o), 1082.5);
});
test('a scraped subtotal or tax does not change the base', () => {
  const withExtras = { ...o, merchandiseSubtotal: 1000, taxAmount: 82.5 } as typeof o;
  assert.equal(costcoReward(withExtras, 2), 21.65);
});
test('a zero purchase price earns nothing', () => {
  assert.equal(costcoReward({ ...o, cost: 0 }, 2), 0);
  assert.equal(costcoReward({ ...o, cost: null }, 2), 0);
});
test('returned units come off the base', () => {
  assert.equal(costcoReward({ ...o, returnedCost: 541.25 }, 2), 10.83);
  assert.equal(costcoReward({ ...o, returnedCost: 5000 }, 2), 0);
});
test('no reward: other stores, cancelled orders, rate off', () => {
  assert.equal(costcoReward({ ...o, platform: 'Amazon' }, 2), null);
  assert.equal(costcoReward({ ...o, cancelled: true }, 2), null);
  assert.equal(costcoReward(o, 0), null);
  assert.equal(costcoReward(o, NaN), null);
});
test('platform match ignores case and spaces', () => {
  assert.ok(isCostco(' costco '));
  assert.ok(!isCostco('Costco Business'));
  assert.ok(!isCostco(null));
});
test('rate setting: unset is the default, 0 is off, junk is the default', () => {
  assert.equal(parseRewardRate(undefined), COSTCO_REWARD_DEFAULT_RATE);
  assert.equal(parseRewardRate(''), 2);
  assert.equal(parseRewardRate('0'), 0);
  assert.equal(parseRewardRate('2.5%'), 2.5);
  assert.equal(parseRewardRate('abc'), 2);
  assert.equal(parseRewardRate('-3'), 0);
});
test('scraped subtotal: numbers only', () => {
  assert.equal(cleanSubtotal(12.345), 12.35);
  assert.equal(cleanSubtotal('12'), null);
  assert.equal(cleanSubtotal(-1), null);
  assert.equal(cleanSubtotal(Infinity), null);
});
