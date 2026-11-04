import test from 'node:test';
import assert from 'node:assert/strict';

import { draftFromPhoto, receiptItems } from './photoDraft.ts';

const ctx = {
  platforms: ['Costco', 'Walmart'],
  merchants: ['Uber Eats', 'DoorDash'],
  cards: [{ id: 7, last4s: ['4821'] }],
};

test('receiptItems: item lines in order, totals and tender lines skipped', () => {
  const items = receiptItems(['282 UBER EATS GC 79.99', '124 DOORDASH GC 79.99 A', '  SUBTOTAL 159.98', '999 TAX 0.00', '282 UBER EATS GC 79.99', 'thanks']);
  assert.deepEqual(items, ['UBER EATS GC', 'DOORDASH GC']);
});

test('draft from a Costco receipt: store, date, cost, card, barcode rebuilt from the summary line', () => {
  const d = draftFromPhoto({
    kind: 'receipt',
    texts: ['COSTCO WHOLESALE', '282 UBER EATS GC 79.99', 'SUBTOTAL 79.99', 'TOTAL 79.99', 'VISA ****4821', '10/28/2026', '11:53 1320 9 75 13'],
    candidates: [],
  }, ctx);
  assert.ok(d);
  assert.equal(d.platform, 'Costco');
  assert.equal(d.orderDate, '2026-10-28');
  assert.equal(d.cost, '79.99');
  assert.equal(d.cardId, 7);
  assert.equal(d.orderNumber, '21132000900752610281153');
  assert.equal(d.itemDescription, 'UBER EATS GC');
});

test('no draft without a store, an amount or a date, or for a card photo', () => {
  assert.equal(draftFromPhoto({ kind: 'receipt', texts: ['SUBTOTAL 10.00', '10/28/2026'], candidates: [] }, ctx), null);
  assert.equal(draftFromPhoto({ kind: 'receipt', texts: ['COSTCO WHOLESALE', '10/28/2026'], candidates: [] }, ctx), null);
  assert.equal(draftFromPhoto({ kind: 'gift_card', texts: ['COSTCO WHOLESALE', 'TOTAL 10.00', '10/28/2026'], candidates: [] }, ctx), null);
});

test('photo date alone does not invent a Costco barcode', () => {
  const d = draftFromPhoto({
    kind: 'receipt', texts: ['COSTCO WHOLESALE', 'TOTAL 79.99', '11:53 1320 9 75 13'], candidates: [], capturedAt: '2026-10-28T12:00:00Z',
  }, ctx);
  if (d) assert.equal(d.orderNumber, null);
});
