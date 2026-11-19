import test from 'node:test';
import assert from 'node:assert/strict';
import { planPayPalApply, paypalNoteLine, cardsWithLast4, type CardRef } from './paypalApply.ts';
import { paypalTxnIds } from './paypalMatch.ts';
import type { PayPalReceipt } from './paypalReceipt.ts';

// Synthetic fixtures only.
const receipt = (over: Partial<PayPalReceipt> = {}): PayPalReceipt => ({
  merchant: 'Example Store Inc', amount: 123.45, date: '2026-11-15', network: 'Visa', last4: '4242', txnId: 'ABCDE12345FGHIJ67', orderRef: '', ...over,
});
const cards: CardRef[] = [{ id: 10, last4s: ['4242'] }, { id: 11, last4s: ['1111', '2222'] }, { id: 12, last4s: ['3333'] }];
const order = (over: Partial<{ notes: string | null; cardId: number | null }> = {}) =>
  ({ notes: null, cardId: null, ...over });

test('the note line, with and without a card', () => {
  assert.equal(paypalNoteLine(receipt()), 'PayPal: paid with Visa ending 4242 (transaction ABCDE12345FGHIJ67)');
  assert.equal(paypalNoteLine(receipt({ network: null })), 'PayPal: paid with card ending 4242 (transaction ABCDE12345FGHIJ67)');
  assert.equal(paypalNoteLine(receipt({ network: null, last4: null })), 'PayPal: paid (transaction ABCDE12345FGHIJ67)');
});

test('the note line carries the transaction id the matcher looks for', () => {
  const a = planPayPalApply(receipt(), order(), cards);
  assert.deepEqual(paypalTxnIds(a.notes), ['ABCDE12345FGHIJ67']);
});

test('an order with no card gets the card whose last four matches', () => {
  const a = planPayPalApply(receipt(), order(), cards);
  assert.deepEqual([a.cardId, a.outcome], [10, 'set']);
  assert.equal(a.notes, 'PayPal: paid with Visa ending 4242 (transaction ABCDE12345FGHIJ67)');
});

test('an additional last four (CreditCardLastFour) matches too', () => {
  const a = planPayPalApply(receipt({ last4: '2222' }), order(), cards);
  assert.deepEqual([a.cardId, a.outcome], [11, 'set']);
});

test('existing notes are kept and the line is added under them', () => {
  const a = planPayPalApply(receipt(), order({ notes: 'gift for sam\n' }), cards);
  assert.equal(a.notes, 'gift for sam\nPayPal: paid with Visa ending 4242 (transaction ABCDE12345FGHIJ67)');
});

test('the same card already on the order: only the note', () => {
  const a = planPayPalApply(receipt(), order({ cardId: 10 }), cards);
  assert.deepEqual([a.cardId, a.outcome], [null, 'same']);
  assert.equal(a.notes.split('\n').length, 1);
});

test('a different card is never replaced, however it got there: only the mismatch is noted', () => {
  for (const userEditedFields of [null, '[]', '["cardId"]']) {
    const a = planPayPalApply(receipt(), { ...order({ cardId: 12 }), userEditedFields } as never, cards);
    assert.deepEqual([a.cardId, a.outcome], [null, 'differs'], String(userEditedFields));
    assert.match(a.notes, /ending 4242 differs from this order's card; left as it is/);
    assert.match(a.notes, /^PayPal: paid with Visa ending 4242 \(transaction ABCDE12345FGHIJ67\)/);
  }
});

test('no card change when the last four matches no card, several cards, or is absent', () => {
  const none = planPayPalApply(receipt({ last4: '9999' }), order({ cardId: 12 }), cards);
  assert.deepEqual([none.cardId, none.outcome], [null, 'no-card']);
  const two = planPayPalApply(receipt(), order(), [{ id: 1, last4s: ['4242'] }, { id: 2, last4s: ['4242', '0001'] }]);
  assert.deepEqual([two.cardId, two.outcome], [null, 'no-card']);
  const balance = planPayPalApply(receipt({ network: null, last4: null }), order({ cardId: 12 }), cards);
  assert.deepEqual([balance.cardId, balance.outcome], [null, 'no-card']);
  assert.equal(balance.notes, 'PayPal: paid (transaction ABCDE12345FGHIJ67)');
});

test('cardsWithLast4', () => {
  assert.deepEqual(cardsWithLast4(cards, '1111').map(c => c.id), [11]);
  assert.deepEqual(cardsWithLast4(cards, '0000'), []);
});
