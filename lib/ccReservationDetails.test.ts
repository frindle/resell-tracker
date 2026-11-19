import test from 'node:test';
import assert from 'node:assert/strict';
import { shapeReservationDetails, cardCountFit } from './ccReservationDetails.ts';

test('shapes rate, per-card and total payout from a reservation', () => {
  const d = shapeReservationDetails({
    value: 50, quantity: 4, rate: 0.87, paymentTerms: 7, submissionTerms: 3, flexType: 'Flex', status: 'Approved',
    date: '2026-11-18', buyOrder: { id: 12, buyer: { displayName: 'Test Buyer' } },
  });
  assert.equal(d.payoutPerCard, 43.5);
  assert.equal(d.payoutTotal, 174);
  assert.equal(d.buyerName, 'Test Buyer');
  assert.equal(d.buyOrderId, 12);
  assert.equal(d.paymentTerms, 7);
});

test('missing fields come back null rather than NaN', () => {
  const d = shapeReservationDetails({ value: 25, quantity: 2 });
  assert.equal(d.rate, null);
  assert.equal(d.payoutPerCard, null);
  assert.equal(d.payoutTotal, null);
  assert.equal(d.buyerName, null);
});

test('cardCountFit compares cards being submitted to cards wanted', () => {
  assert.equal(cardCountFit(4, 4), 'exact');
  assert.equal(cardCountFit(4, 2), 'short');
  assert.equal(cardCountFit(2, 4), 'over');
});
