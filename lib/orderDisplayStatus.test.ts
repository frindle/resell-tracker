/**
 *   node --experimental-strip-types --test lib/orderDisplayStatus.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { allGiftCardsSubmitted, displayPaymentStatus, type PaymentStatus } from './orderDisplayStatus.ts';

const sub = { ccSubmittedAt: '2026-09-01T00:00:00.000Z' };
const unsub = { ccSubmittedAt: null };
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
  assert.equal(allGiftCardsSubmitted([{ ccSubmittedAt: new Date() }]), true);
});
