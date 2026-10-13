import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateCardBonus } from './lib/cardBonuses.ts';


test('returns none tier for cardValue below 10', () => {
  const result = calculateCardBonus(5);
  assert.strictEqual(result.bonusTier, 'none');
  assert.strictEqual(result.bonusAmount, 0);
});

test('returns bronze tier for cardValue 10-49', () => {
  const result = calculateCardBonus(25);
  assert.strictEqual(result.bonusTier, 'bronze');
  assert.strictEqual(result.bonusAmount, 25 * 0.05);
});

test('returns silver tier for cardValue 50-99', () => {
  const result = calculateCardBonus(75);
  assert.strictEqual(result.bonusTier, 'silver');
  assert.strictEqual(result.bonusAmount, 75 * 0.1);
});

test('returns gold tier for cardValue 100+', () => {
  const result = calculateCardBonus(150);
  assert.strictEqual(result.bonusTier, 'gold');
  assert.strictEqual(result.bonusAmount, 150 * 0.2);
});

test('handles boundary value of exactly 10', () => {
  const result = calculateCardBonus(10);
  assert.strictEqual(result.bonusTier, 'bronze');
  assert.strictEqual(result.bonusAmount, 10 * 0.05);
});

test('handles boundary value of exactly 50', () => {
  const result = calculateCardBonus(50);
  assert.strictEqual(result.bonusTier, 'silver');
  assert.strictEqual(result.bonusAmount, 50 * 0.1);
});

test('handles boundary value of exactly 100', () => {
  const result = calculateCardBonus(100);
  assert.strictEqual(result.bonusTier, 'gold');
  assert.strictEqual(result.bonusAmount, 100 * 0.2);
});

test('handles zero cardValue', () => {
  const result = calculateCardBonus(0);
  assert.strictEqual(result.bonusTier, 'none');
  assert.strictEqual(result.bonusAmount, 0);
});

test('handles negative cardValue', () => {
  const result = calculateCardBonus(-10);
  assert.strictEqual(result.bonusTier, 'none');
  assert.strictEqual(result.bonusAmount, 0);
});
