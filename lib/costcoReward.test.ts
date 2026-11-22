import { test } from 'node:test';
import assert from 'node:assert/strict';
import { costcoReward, costcoRewardBase, parseRewardRate, isCostco, cleanSubtotal, COSTCO_REWARD_DEFAULT_RATE } from './costcoReward.ts';

const o = { platform: 'Costco', cost: 1082.5, taxAmount: null, merchandiseSubtotal: 1000 };

test('2% of the merchandise subtotal, not the order total', () => {
  assert.equal(costcoReward(o, 2), 20);
  assert.deepEqual(costcoRewardBase(o), { base: 1000, exact: true });
});
test('without a subtotal: cost less known tax, marked as an estimate', () => {
  assert.deepEqual(costcoRewardBase({ platform: 'Costco', cost: 1082.5, taxAmount: 82.5 }), { base: 1000, exact: false });
  assert.deepEqual(costcoRewardBase({ platform: 'Costco', cost: 1082.5 }), { base: 1082.5, exact: false });
  assert.equal(costcoReward({ platform: 'Costco', cost: 1082.5 }, 2), 21.65);
});
test('a zero subtotal is real (an all-discount order earns nothing)', () => {
  assert.equal(costcoReward({ ...o, merchandiseSubtotal: 0 }, 2), 0);
});
test('returned units come off the base', () => {
  assert.equal(costcoReward({ ...o, returnedCost: 541.25 }, 2), 10);
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
