import { test } from 'node:test';
import assert from 'node:assert/strict';
import { offerFor, offerReservationId } from './ccOffer.ts';

const offers = [{ reservation: { id: 753927, seller: { id: 1 } } }, { reservation: { id: 753953, seller: { id: 1 } } }];

test('offerFor picks the reservation the user chose, not the first one CC lists', () => {
  assert.equal(offerFor(offers, 753953)?.reservation?.id, 753953);
  assert.equal(offerFor(offers, 753927)?.reservation?.id, 753927);
});

test('offerFor falls back to the first offer when the chosen one is not listed, and handles none', () => {
  assert.equal(offerFor(offers, 1)?.reservation?.id, 753927);
  assert.equal(offerFor([], 1), undefined);
  assert.equal(offerFor(undefined, 1), undefined);
  assert.equal(offerFor([{ reservation: { id: '753953' } }], 753953)?.reservation?.id, '753953', 'a string id still matches');
});

test('offerReservationId records where the cards actually went', () => {
  assert.equal(offerReservationId(offers[0], 753953), 753927);
  assert.equal(offerReservationId({ reservation: {} }, 753953), 753953);
  assert.equal(offerReservationId(undefined, 753953), 753953);
});
