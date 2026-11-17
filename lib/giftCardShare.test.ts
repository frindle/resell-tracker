import { test } from 'node:test';
import assert from 'node:assert/strict';
import { submittedShare } from './giftCardShare.ts';

const card = (value: number | null, sent: boolean) => ({ value, ccSubmittedAt: sent ? '2026-11-13' : null });

test('no gift cards: the whole order counts', () => {
  assert.equal(submittedShare([]), 1);
  assert.equal(submittedShare(undefined), 1);
});
test('all submitted: 1, none submitted: 0', () => {
  assert.equal(submittedShare([card(50, true), card(50, true)]), 1);
  assert.equal(submittedShare([card(50, false), card(50, false)]), 0);
});
test('order 1039 shape: four of eight $50 cards sent is half', () => {
  const cards = [...Array(4)].map(() => card(50, true)).concat([...Array(4)].map(() => card(50, false)));
  assert.equal(submittedShare(cards), 0.5);
});
test('share is by face value, not card count', () => {
  assert.equal(submittedShare([card(100, true), card(25, false), card(25, false), card(50, false)]), 0.5);
});
test('no usable values: share by count', () => {
  assert.equal(submittedShare([card(null, true), card(0, false), card(null, false), card(null, false)]), 0.25);
});
