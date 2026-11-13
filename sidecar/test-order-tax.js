'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { applyTax, taxFields } = require('./src/orderTax.js');

test('tax and cost known -> tax and pre-tax subtotal set, cost untouched', () => {
  const o = applyTax({ cost: 108.25 }, 8.25);
  assert.deepEqual(o, { cost: 108.25, taxAmount: 8.25, subtotalAmount: 100 });
});
test('no tax scraped -> nothing added', () => {
  assert.deepEqual(applyTax({ cost: 50 }, null), { cost: 50 });
  assert.deepEqual(applyTax({ cost: 50 }, undefined), { cost: 50 });
});
test('zero tax is a real value (tax-free order)', () => {
  assert.deepEqual(applyTax({ cost: 50 }, 0), { cost: 50, taxAmount: 0, subtotalAmount: 50 });
});
test('cost unknown or tax larger than cost -> nothing added', () => {
  assert.deepEqual(applyTax({ cost: 0 }, 5), { cost: 0 });
  assert.deepEqual(applyTax({ cost: 10 }, 12), { cost: 10 });
  assert.deepEqual(applyTax({ cost: 10 }, NaN), { cost: 10 });
});
test('taxFields mirrors applyTax as a spreadable object', () => {
  assert.deepEqual(taxFields(108.25, 8.25), { taxAmount: 8.25, subtotalAmount: 100 });
  assert.deepEqual(taxFields(108.25, null), {});
});
