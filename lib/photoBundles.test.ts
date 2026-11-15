import test from 'node:test';
import assert from 'node:assert/strict';

import { photoBundles, type BundlePhoto } from './photoBundles.ts';

// Synthetic data only. Barcode: warehouse 1320, register 9, transaction 75, 2026-10-28 11:53.
const BARCODE = '21132000900752610281153';
const SLIP = ['Costco Summary Receipt', '10/28/2026', '11:53 1320 9 75 13', 'ACTIVATED'];
const at = (d: string) => new Date(`2026-10-${d}T20:00:00Z`);
const photo = (id: number, p: Partial<BundlePhoto>): BundlePhoto => ({
  id, createdAt: at('28'), status: 'done', strength: 'none', suggestedOrderId: null, draft: null, lines: [], ...p,
});

test('photos matched to the same order are one set, led by the exact match', () => {
  const b = photoBundles([
    photo(1, { strength: 'likely', suggestedOrderId: 7 }),
    photo(2, { strength: 'exact', suggestedOrderId: 7 }),
    photo(3, { strength: 'exact', suggestedOrderId: 8 }),
    photo(4, { strength: 'ambiguous', suggestedOrderId: 7 }),
  ]);
  assert.deepEqual(b, [{ key: 'o:7', leadId: 2, ids: [1, 2] }]);
});

test('before the order exists: drafts with the same Costco transaction and the card slips that print it', () => {
  const b = photoBundles([
    photo(10, { draft: { orderNumber: BARCODE, itemDescription: '$50 Uber Eats GC', cardId: 6, cost: '79.99' }, lines: SLIP }),
    photo(11, { draft: { orderNumber: BARCODE, itemDescription: null, cardId: null, cost: '79.99' }, lines: SLIP }),
    photo(12, { lines: ['UBER EATS', ...SLIP] }),
    // Same transaction numbers, but uploaded weeks later: another day's purchase.
    photo(13, { createdAt: new Date('2026-12-01T20:00:00Z'), lines: SLIP }),
    // Matched an order already: stays with it.
    photo(14, { strength: 'exact', suggestedOrderId: 3, lines: SLIP }),
  ]);
  assert.deepEqual(b, [{ key: 'c:1320-9-75', leadId: 10, ids: [10, 11, 12] }]);
});

test('drafts from other stores join on the same order number', () => {
  const b = photoBundles([
    photo(20, { draft: { orderNumber: '112-1234567-7654321' } }),
    photo(21, { draft: { orderNumber: '1121234567 7654321' } }),
    photo(22, { draft: { orderNumber: '112-0000000-0000000' } }),
  ]);
  assert.deepEqual(b, [{ key: 'n:11212345677654321', leadId: 20, ids: [20, 21] }]);
});

test('set-aside, unread and lone photos are never a set', () => {
  assert.deepEqual(photoBundles([
    photo(30, { strength: 'exact', suggestedOrderId: 9, manual: true }),
    photo(31, { strength: 'exact', suggestedOrderId: 9, status: 'pending' }),
    photo(32, { strength: 'exact', suggestedOrderId: 9 }),
    photo(33, { lines: SLIP }),
  ]), []);
});

test('no drafted receipt: the receipt and card slips printing one transaction are one set, led by the receipt', () => {
  const later = (id: number) => photo(id, { createdAt: new Date('2026-12-01T20:00:00Z'), lines: SLIP });
  const b = photoBundles([
    photo(40, { kind: 'gift_card', lines: ['DOORDASH GC', 'Costco Summary Receipt', '11:53 1320 9 75 13', 'Activation Successful'] }),
    photo(41, { kind: 'gift_card', lines: ['DOORDASH GC', 'Costco Summary Receipt', '11:53 1320 9 75 13'] }),
    // The register receipt prints the same transaction a minute later; its store name wasn't read, so no draft.
    photo(42, { kind: 'receipt', createdAt: new Date('2026-10-28T20:03:00Z'), lines: ['PH', 'SUBTOTAL 159.98', '10/28/2026', '11:54 1320 9 75 13'] }),
    // Same numbers weeks later: another trip, its own set.
    later(43), later(44),
    // Two transactions on one photo: unclear, left alone.
    photo(45, { lines: [...SLIP, '12:01 1320 4 88 13'] }),
    // Another transaction, alone.
    photo(46, { lines: ['11:53 1320 9 76 13'] }),
  ]);
  assert.deepEqual(b, [
    { key: 'c:1320-9-75@40', leadId: 42, ids: [40, 41, 42] },
    { key: 'c:1320-9-75@43', leadId: 43, ids: [43, 44] },
  ]);
});
