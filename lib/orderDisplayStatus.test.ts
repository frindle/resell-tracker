/**
 *   node --experimental-strip-types --test lib/orderDisplayStatus.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { allGiftCardsSubmitted, displayPaymentStatus, type PaymentStatus } from './orderDisplayStatus.ts';

const sub = { ccSubmittedAt: '2026-09-01T00:00:00.000Z', ccGiftCardId: '8232432' };
const unsub = { ccSubmittedAt: null, ccGiftCardId: null };
const subNoId = { ccSubmittedAt: '2026-09-01T00:00:00.000Z', ccGiftCardId: null };
const base = { cancelled: false, lost: false };

test('all gift cards submitted: pending -> processed', () => {
  assert.equal(displayPaymentStatus('pending', { ...base, giftCards: [sub, sub] }), 'processed');
  assert.equal(displayPaymentStatus('pending', { ...base, giftCards: [sub] }), 'processed');
});

test('some gift cards not submitted: unchanged', () => {
  assert.equal(displayPaymentStatus('pending', { ...base, giftCards: [sub, unsub] }), 'pending');
  assert.equal(displayPaymentStatus('pending', { ...base, giftCards: [unsub] }), 'pending');
});

test('zero gift cards (or none loaded): unchanged', () => {
  assert.equal(displayPaymentStatus('pending', { ...base, giftCards: [] }), 'pending');
  assert.equal(displayPaymentStatus('pending', { ...base }), 'pending');
  assert.equal(displayPaymentStatus('pending', { ...base, giftCards: null }), 'pending');
  assert.equal(allGiftCardsSubmitted([]), false);
});

test('cancelled / lost orders never become processed', () => {
  assert.equal(displayPaymentStatus('pending', { cancelled: true, lost: false, giftCards: [sub] }), 'pending');
  assert.equal(displayPaymentStatus('pending', { cancelled: false, lost: true, giftCards: [sub] }), 'pending');
});

test('other statuses keep their status even when all cards are submitted', () => {
  for (const ps of ['paid', 'partial', 'overdue', 'lost', 'none'] as PaymentStatus[]) {
    assert.equal(displayPaymentStatus(ps, { ...base, giftCards: [sub, sub] }), ps, ps);
  }
});

test('accepts Date submission values', () => {
  assert.equal(allGiftCardsSubmitted([{ ccSubmittedAt: new Date(), ccGiftCardId: '1' }]), true);
});

test('submitted but no CardCenter id: not processed', () => {
  assert.equal(displayPaymentStatus('pending', { ...base, giftCards: [subNoId] }), 'pending');
  assert.equal(displayPaymentStatus('pending', { ...base, giftCards: [{ ccSubmittedAt: '2026-09-01' }] }), 'pending');
  assert.equal(displayPaymentStatus('pending', { ...base, giftCards: [{ ccSubmittedAt: '2026-09-01', ccGiftCardId: '' }] }), 'pending');
});

test('one card missing its id among several: not processed', () => {
  assert.equal(displayPaymentStatus('pending', { ...base, giftCards: [sub, sub, subNoId] }), 'pending');
});

test('all submitted with ids: processed (listing id not required)', () => {
  assert.equal(displayPaymentStatus('pending', { ...base, giftCards: [sub, sub, sub] }), 'processed');
});
