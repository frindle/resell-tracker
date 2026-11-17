import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderPnl } from './orderPnl.ts';

const base = { salePrice: 120, cost: 100, shippingCost: 5, insuranceCost: 2, returnedCost: 0, cashbackAmount: 3, portalCashback: 1, amexOfferDollars: 0 };
const card = (value: number, sent: boolean) => ({ value, ccSubmittedAt: sent ? '2026-11-13' : null });

test('plain order: sale - cost + credits', () => {
  const p = orderPnl(base);
  assert.equal(p.share, 1);
  assert.equal(p.cost, 107);
  assert.equal(p.credits, 4);
  assert.equal(p.effCost, 103);
  assert.equal(p.profit, 17);
});
test('returned units come off the cost', () => {
  assert.equal(orderPnl({ ...base, returnedCost: 50, salePrice: 60 }).profit, 60 - 57 + 4);
});
test('null sale counts as 0, null optional fields as 0', () => {
  assert.equal(orderPnl({ salePrice: null, cost: 10, shippingCost: 0, cashbackAmount: 0 }).profit, -10);
});
test('order 1039 shape: 4 of 8 $50 cards sent for $160 is not a -$160 loss', () => {
  const giftCards = [...Array(8)].map((_, i) => card(50, i < 4));
  const p = orderPnl({ salePrice: 160, cost: 319.96, shippingCost: 0, cashbackAmount: 0, giftCards });
  assert.equal(p.share, 0.5);
  assert.equal(p.cost, 159.98);
  assert.ok(Math.abs(p.profit - 0.02) < 1e-9);
});
test('no cards sent: nothing sold, nothing counted', () => {
  const p = orderPnl({ salePrice: null, cost: 100, shippingCost: 0, cashbackAmount: 2, giftCards: [card(50, false), card(50, false)] });
  assert.equal(p.profit, 0);
});
