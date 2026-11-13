import test from 'node:test';
import assert from 'node:assert/strict';

import { costcoGiftLines, type OcrBox } from './costcoGiftLines.ts';

// Synthetic numbers only, never a real card's.
const PC1 = '7000000000000001';
const PC2 = '7000000000000002';
const PC3 = '7000000000000003';

test('text only: an item followed by its activation line is a gift card; groceries are not', () => {
  const lines = costcoGiftLines([
    'COSTCO WHOLESALE',
    '1473917 KS TRAIL MIX 17.59 A',
    `282 UBER EATS 79.99`,
    `PC ${PC1} ACTIVATED`,
    '124 DOORDASH GC 79.99',
    `PC ${PC2} ACTIVATED`,
    'SUBTOTAL 177.57',
  ]);
  assert.deepEqual(lines, [
    { name: 'UBER EATS', price: 79.99, activation: PC1 },
    { name: 'DOORDASH GC', price: 79.99, activation: PC2 },
  ]);
});

test('no activation line, no gift cards', () => {
  assert.deepEqual(costcoGiftLines(['282 UBER EATS GC 79.99', 'TOTAL 79.99']), []);
});

test('boxes: price on its own box on the item row, lines out of order, a second OCR variant ignored', () => {
  const row = (text: string, x0: number, y: number, x1 = x0 + 0.1): OcrBox => ({ text, box: [x0, y, x1, y + 0.011] });
  const boxes: OcrBox[] = [
    row('79.99', 0.545, 0.300),
    row('282 UBER EATS', 0.414, 0.300),
    row(`PC ${PC1} ACTIVATED`, 0.414, 0.309, 0.6),
    row('124 DOORDASH GC', 0.414, 0.330),
    row('79.99', 0.545, 0.330),
    row(`PC ${PC2} ACTIVATED`, 0.414, 0.339, 0.6),
    row('124 DOORDASH GC', 0.414, 0.360),
    row(`PC ${PC3} ACTIVATED`, 0.414, 0.369, 0.6),
    // The same printed line read again by another variant, one digit off.
    row(`PC ${PC3.slice(0, -1)}8 ACTIVATED`, 0.415, 0.3692, 0.6),
    row('17.59', 0.545, 0.400),
    row('1473917 KS TRAIL MIX', 0.414, 0.400),
  ];
  const texts = boxes.map(b => b.text);
  const lines = costcoGiftLines(texts, boxes);
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.map(l => l.name), ['UBER EATS', 'DOORDASH GC', 'DOORDASH GC']);
  // The third card's price wasn't read on its row: it takes the same item's.
  assert.deepEqual(lines.map(l => l.price), [79.99, 79.99, 79.99]);
});

test('text only: packs with numbers a digit apart are two cards; the same number twice is one', () => {
  const lines = costcoGiftLines([
    '282 UBER EATS 79.99', `PC ${PC1} ACTIVATED`,
    '282 UBER EATS 79.99', `PC ${PC2} ACTIVATED`,
    // A second OCR variant's reading of the same receipt.
    '282 UBER EATS 79.99', `PC ${PC1} ACTIVATED`,
  ]);
  assert.deepEqual(lines.map(l => l.activation), [PC1, PC2]);
});
