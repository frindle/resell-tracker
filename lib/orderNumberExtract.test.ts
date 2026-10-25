import test from 'node:test';
import assert from 'node:assert/strict';

import { extractOrderNumbers, pickOrderForNumbers } from './orderNumberExtract.ts';

test('extracts Amazon-style order number from OCR lines', () => {
  const out = extractOrderNumbers(['Thanks for shopping', 'Order 112-3456789-0123456 placed']);
  assert.ok(out.includes('112-3456789-0123456'));
});

test('extracts generic "Order # XXXX" and ignores noise', () => {
  const out = extractOrderNumbers(['Order # AB12345', 'total $5.00']);
  assert.ok(out.some(s => s.replace(/[\s-]/g, '').toUpperCase() === 'AB12345'));
  assert.deepEqual(extractOrderNumbers(['hello world', '$12.00']), []);
});

test('pickOrderForNumbers: unique match is case/dash/space-insensitive', () => {
  const orders = [
    { id: 1, orderNumber: '112-3456789-0123456' },
    { id: 2, orderNumber: 'ab12345' },
    { id: 3, orderNumber: null },
  ];
  assert.equal(pickOrderForNumbers(['1123456789 0123456'], orders), 1);
  assert.equal(pickOrderForNumbers(['AB-12345'], orders), 2);
});

test('pickOrderForNumbers: no match and ambiguous return null', () => {
  const orders = [
    { id: 1, orderNumber: 'X100' },
    { id: 2, orderNumber: 'x-100' },
    { id: 3, orderNumber: 'Y200' },
  ];
  assert.equal(pickOrderForNumbers(['Z999'], orders), null);
  assert.equal(pickOrderForNumbers(['X100'], orders), null);
});
