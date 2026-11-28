import test from 'node:test';
import assert from 'node:assert/strict';

import { brandFromDescription, faceValueIn, orderCardDefaults, suggestionValue } from './giftCardDefaults.ts';

test('a single printed face value is read; none, several or a price are not', () => {
  assert.equal(faceValueIn('$100 DoorDash GC'), 100);
  assert.equal(faceValueIn('GIFT CARD $ 50'), 50);
  assert.equal(faceValueIn('$25.00'), 25);
  assert.equal(faceValueIn('$100 card, $100 value'), 100);
  assert.equal(faceValueIn('$50 Uber Eats + $100 DoorDash'), null);
  assert.equal(faceValueIn('SUBTOTAL $79.99'), null);
  assert.equal(faceValueIn('$1,000'), null);
  assert.equal(faceValueIn('$2 off'), null);
  assert.equal(faceValueIn(''), null);
  assert.equal(faceValueIn(null), null);
});

test('the brand comes from a one-brand gift card description only', () => {
  assert.equal(brandFromDescription('$50 DoorDash GC'), 'DoorDash');
  assert.equal(brandFromDescription('2x $100 Apple Gift Card'), 'Apple');
  assert.equal(brandFromDescription('$100 Uber eGift Card'), 'Uber Eats');
  assert.equal(brandFromDescription('$50 Uber Eats & DoorDash GC'), '');
  assert.equal(brandFromDescription('Apple Gift Card - App Store, iTunes'), '');
  assert.equal(brandFromDescription('MacBook Pro 14'), '');
  assert.equal(brandFromDescription(null), '');
});

test('order defaults: the cards already on the order first, then the description, else blank', () => {
  assert.deepEqual(orderCardDefaults('$50 DoorDash GC', [{ merchant: 'Starbucks', value: 25 }, { merchant: 'Starbucks', value: 25 }]),
    { merchant: 'Starbucks', merchantFrom: 'cards', value: 25, valueFrom: 'cards' });
  // cards with mixed values: the description's value
  assert.deepEqual(orderCardDefaults('$50 DoorDash GC', [{ merchant: 'DoorDash', value: 50 }, { merchant: 'DoorDash', value: 100 }]),
    { merchant: 'DoorDash', merchantFrom: 'cards', value: 50, valueFrom: 'order' });
  assert.deepEqual(orderCardDefaults('$50 DoorDash GC', []), { merchant: 'DoorDash', merchantFrom: 'order', value: 50, valueFrom: 'order' });
  assert.deepEqual(orderCardDefaults('Laptop $999', []), { merchant: '', merchantFrom: null, value: null, valueFrom: null });
  assert.deepEqual(orderCardDefaults(null, []), { merchant: '', merchantFrom: null, value: null, valueFrom: null });
});

test("a code's own photo value beats the order default", () => {
  const d = orderCardDefaults('$50 DoorDash GC', []);
  assert.deepEqual(suggestionValue(['DOORDASH', '$100', '1234 5678'], d), { value: 100, valueFrom: 'photo' });
  assert.deepEqual(suggestionValue(['DOORDASH', 'NO AMOUNT'], d), { value: 50, valueFrom: 'order' });
  assert.deepEqual(suggestionValue(['$25', '$100'], d), { value: 50, valueFrom: 'order' });
});
