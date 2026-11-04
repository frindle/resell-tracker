import test from 'node:test';
import assert from 'node:assert/strict';

import { prefillFromPhoto } from './photoPrefill.ts';

const ctx = {
  platforms: ['Amazon', 'Walmart', 'Best Buy'],
  merchants: ['Apple', 'Best Buy', 'Buy Buy Baby', 'Target'],
  cards: [{ id: 7, last4s: ['4821'] }, { id: 8, last4s: ['1111'] }],
};

test('gift card: long code is the number, labelled PIN, face value, longest brand name', () => {
  const p = prefillFromPhoto({
    kind: 'gift_card',
    texts: ['BEST BUY', 'Gift Card $100', 'PIN: 4417', 'valid at Best Buy stores'],
    candidates: ['4417', '6155123412341234'],
  }, ctx);
  assert.deepEqual(p.giftCard, { merchant: 'Best Buy', value: '100', cardNumber: '6155123412341234', pin: '4417' });
  assert.equal(p.cost, undefined, 'a gift card photo is not read as a receipt');
});

test('gift card with no long code gives no card', () => {
  const p = prefillFromPhoto({ kind: 'gift_card', texts: ['$50'], candidates: ['1234'] }, ctx);
  assert.equal(p.giftCard, undefined);
});

test('receipt: subtotal as price, date, order number, the one card with that last 4', () => {
  const p = prefillFromPhoto({
    kind: 'receipt',
    texts: ['Walmart', 'Order # 2000123456789', 'SUBTOTAL', '$499.99', 'TOTAL $544.36', 'VISA ****4821', '10/21/2026'],
    candidates: [],
  }, ctx);
  assert.equal(p.platform, 'Walmart');
  assert.equal(p.cost, '499.99');
  assert.equal(p.orderDate, '2026-10-21');
  assert.equal(p.orderNumber, '2000123456789');
  assert.equal(p.cardId, 7);
  assert.equal(p.giftCard, undefined);
});

test('receipt card last 4 shared by two cards picks none', () => {
  const p = prefillFromPhoto(
    { kind: 'receipt', texts: ['Total $10.00', 'ending in 4821'], candidates: [] },
    { ...ctx, cards: [{ id: 1, last4s: ['4821'] }, { id: 2, last4s: ['4821'] }] },
  );
  assert.equal(p.cardId, undefined);
});

test('no printed date falls back to the photo date', () => {
  const p = prefillFromPhoto({ kind: 'receipt', texts: ['Total $10.00'], candidates: [], capturedAt: '2026-10-03T12:00:00Z' }, ctx);
  assert.equal(p.orderDate, '2026-10-03');
});
