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
  // an OCR O-for-0 misread is no value; sentence punctuation after the amount is fine
  assert.equal(faceValueIn('$5O'), null);
  assert.equal(faceValueIn('$10O'), null);
  assert.equal(faceValueIn('Value: $100.'), 100);
  assert.equal(faceValueIn('$50, no fees'), 50);
  assert.equal(faceValueIn('$25.00.'), 25);
  assert.equal(faceValueIn('$100.50'), null);
});

const KNOWN = ['DoorDash', 'Apple', 'Uber Eats', 'Best Buy', 'Visa'];

test('the brand comes from a one-brand gift card description, and only a brand already on the cards', () => {
  assert.equal(brandFromDescription('$50 DoorDash GC', KNOWN), 'DoorDash');
  assert.equal(brandFromDescription('2x $100 Apple Gift Card', KNOWN), 'Apple');
  assert.equal(brandFromDescription('$100 Uber eGift Card', KNOWN), 'Uber Eats');
  assert.equal(brandFromDescription('$50 Uber Eats & DoorDash GC', KNOWN), '');
  assert.equal(brandFromDescription('Apple Gift Card - App Store, iTunes', KNOWN), '');
  assert.equal(brandFromDescription('MacBook Pro 14', KNOWN), '');
  assert.equal(brandFromDescription(null, KNOWN), '');
  // leftover words never become the brand
  assert.equal(brandFromDescription('DoorDash Gift Card $50 - Holiday Design', KNOWN), 'DoorDash');
  assert.equal(brandFromDescription('$50 Visa Gift Card (plus $5.95 Purchase Fee)', KNOWN), 'Visa');
  assert.equal(brandFromDescription('Best Buy® Gift Card $100', KNOWN), 'Best Buy');
  // a brand not on any card yet is left blank for the person to type
  assert.equal(brandFromDescription('$50 Starbucks Gift Card', KNOWN), '');
  assert.equal(brandFromDescription('$50 DoorDash GC', []), '');
  // no partial-word match
  assert.equal(brandFromDescription('$50 Applebee\'s Gift Card', KNOWN), '');
});

test('order defaults: the cards already on the order first, then the description, else blank', () => {
  assert.deepEqual(orderCardDefaults('$50 DoorDash GC', [{ merchant: 'Starbucks', value: 25 }, { merchant: 'Starbucks', value: 25 }]),
    { merchant: 'Starbucks', merchantFrom: 'cards', value: 25, valueFrom: 'cards' });
  // cards with mixed values: the description's value
  assert.deepEqual(orderCardDefaults('$50 DoorDash GC', [{ merchant: 'DoorDash', value: 50 }, { merchant: 'DoorDash', value: 100 }]),
    { merchant: 'DoorDash', merchantFrom: 'cards', value: 50, valueFrom: 'order' });
  assert.deepEqual(orderCardDefaults('$50 DoorDash GC', [], KNOWN), { merchant: 'DoorDash', merchantFrom: 'order', value: 50, valueFrom: 'order' });
  // no known brands yet: the value still comes from the description, the brand is left blank
  assert.deepEqual(orderCardDefaults('$50 DoorDash GC', []), { merchant: '', merchantFrom: null, value: 50, valueFrom: 'order' });
  assert.deepEqual(orderCardDefaults('Laptop $999', [], KNOWN), { merchant: '', merchantFrom: null, value: null, valueFrom: null });
  assert.deepEqual(orderCardDefaults(null, [], KNOWN), { merchant: '', merchantFrom: null, value: null, valueFrom: null });
});

test("a code's own photo value beats the order default", () => {
  const d = orderCardDefaults('$50 DoorDash GC', [], KNOWN);
  assert.deepEqual(suggestionValue(['DOORDASH', '$100', '1234 5678'], d), { value: 100, valueFrom: 'photo' });
  assert.deepEqual(suggestionValue(['DOORDASH', 'NO AMOUNT'], d), { value: 50, valueFrom: 'order' });
  assert.deepEqual(suggestionValue(['$25', '$100'], d), { value: 50, valueFrom: 'order' });
});
