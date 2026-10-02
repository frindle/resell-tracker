/**
 *   node --experimental-strip-types --test lib/orderDisplayStatus.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { paymentStatus, type OrderForPaymentStatus } from './paymentStatus.ts';
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

// Paid by any route must show Paid, never Processed, even with every card
// submitted and linked. Built on the real paymentStatus() derivation.
const payOrder = (over: Partial<OrderForPaymentStatus>): OrderForPaymentStatus => ({
  lost: false, cancelled: false, salePriceSynced: false, salePrice: 100, bgPaidAmount: null,
  bgExpectedPayout: null, bgCredited: false, bfmrStatus: null, overdueAt: null,
  buyer: { name: 'CardCenter' }, returns: [], commitmentLinks: [], bfmrLinks: [], ...over,
});
const shown = (over: Partial<OrderForPaymentStatus>) =>
  displayPaymentStatus(paymentStatus(payOrder(over)), { cancelled: false, lost: false, giftCards: [sub, sub] });

test('control: unpaid order with all cards submitted + ids is processed', () => {
  assert.equal(shown({}), 'processed');
});

test('manually marked paid (salePriceSynced) + all cards submitted: Paid', () => {
  assert.equal(shown({ salePriceSynced: true }), 'paid');
});

test('CardCenter-paid (bgPaidAmount covers the sale, synced) + all cards submitted: Paid', () => {
  assert.equal(shown({ bgPaidAmount: 100, salePriceSynced: true }), 'paid');
  assert.equal(shown({ bgPaidAmount: 100 }), 'paid');
});

test('fully paid by BG/BFMR (bgPaidAmount >= expected payout) + all cards submitted: Paid', () => {
  assert.equal(shown({ bgPaidAmount: 90, bgExpectedPayout: 90, bgCredited: true, bfmrStatus: 'paid' }), 'paid');
});

test('partially paid stays Partial', () => {
  assert.equal(shown({ bgPaidAmount: 40, bgExpectedPayout: 90 }), 'partial');
});
