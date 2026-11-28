import test from 'node:test';
import assert from 'node:assert/strict';
import { finalShortPay, shortPaidLine } from './bgShortPaid.ts';

const base = { fullyCredited: true, trulyPaid: 894.94, inBalance: 894.94, expected: 899.91 };

test('fully credited, all in-balance paid, under expected: the dollars short', () => {
  assert.equal(finalShortPay(base), 4.97);
});
test('not final when a shipment has no receipt yet', () => {
  assert.equal(finalShortPay({ ...base, fullyCredited: false }), null);
});
test('not final when some in-balance money is not paid yet', () => {
  assert.equal(finalShortPay({ ...base, inBalance: 899.91 }), null);
});
test('paid in full (within a cent) or over is not short', () => {
  assert.equal(finalShortPay({ ...base, trulyPaid: 899.91, inBalance: 899.91 }), null);
  assert.equal(finalShortPay({ ...base, trulyPaid: 899.905, inBalance: 899.905 }), null);
  assert.equal(finalShortPay({ ...base, trulyPaid: 905, inBalance: 905 }), null);
});
test('missing figures are not short', () => {
  assert.equal(finalShortPay({ ...base, trulyPaid: null }), null);
  assert.equal(finalShortPay({ ...base, inBalance: null }), null);
  assert.equal(finalShortPay({ ...base, expected: null }), null);
});
test('digest line', () => {
  assert.equal(shortPaidLine('A-100', 7, 4.97), 'BG paid $4.97 less than expected on #A-100');
  assert.equal(shortPaidLine(null, 7, 4.97), 'BG paid $4.97 less than expected on #7');
});
