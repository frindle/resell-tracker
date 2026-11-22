import test from 'node:test';
import assert from 'node:assert/strict';
import { isSubtotalPayload, payloadOrderNumbers, subtotalFill, subtotalOrderNumbers, subtotalPayloads } from './costcoSubtotalPlan.ts';

const o = (orderNumber: string | null, extra: Partial<{ platform: string; cancelled: boolean; merchandiseSubtotal: number | null }> = {}) =>
  ({ platform: 'Costco', orderNumber, cancelled: false, merchandiseSubtotal: null, ...extra });

test('only live Costco orders with no subtotal are read, once each, digits only', () => {
  const got = subtotalOrderNumbers([
    o('111-222'),
    o('111222'), // same order again
    o('333', { merchandiseSubtotal: 10 }),
    o('444', { cancelled: true }),
    o('555', { platform: 'Walmart' }),
    o('666', { platform: ' costco ' }),
    o(null),
    o('abc'),
  ]);
  assert.deepEqual(got, ['111222', '666']);
});

test('orders already waiting in a subtotal command are not queued again', () => {
  assert.deepEqual(subtotalOrderNumbers([o('1'), o('2'), o('3')], ['2']), ['1', '3']);
});

test('payloads hold at most 25 orders each and are marked subtotalOnly', () => {
  const nums = Array.from({ length: 26 }, (_, i) => String(i + 1));
  const ps = subtotalPayloads(nums, 7);
  assert.equal(ps.length, 2);
  assert.equal(ps[0].orderNumbers.length, 25);
  assert.deepEqual(ps[1], { orderNumbers: ['26'], userId: 7, subtotalOnly: true });
  assert.deepEqual(subtotalPayloads([], 7), []);
});

test('a stored payload is told apart from a gap-fill one', () => {
  assert.equal(isSubtotalPayload(JSON.stringify(subtotalPayloads(['1'], 1)[0])), true);
  assert.equal(isSubtotalPayload(JSON.stringify({ orderNumbers: ['1'], userId: 1 })), false);
  assert.equal(isSubtotalPayload('not json'), false);
  assert.equal(isSubtotalPayload(null), false);
  assert.deepEqual(payloadOrderNumbers(JSON.stringify({ orderNumbers: ['12-3', 4] })), ['123', '4']);
  assert.deepEqual(payloadOrderNumbers('{'), []);
});

test('a subtotal row fills only an empty subtotal on a live Costco order', () => {
  assert.equal(subtotalFill({ platform: 'Costco', cancelled: false, merchandiseSubtotal: null }, { merchandiseSubtotal: 99.5 }), 99.5);
  assert.equal(subtotalFill({ platform: 'Costco', cancelled: false, merchandiseSubtotal: 80 }, { merchandiseSubtotal: 99.5 }), null);
  assert.equal(subtotalFill({ platform: 'Costco', cancelled: true, merchandiseSubtotal: null }, { merchandiseSubtotal: 99.5 }), null);
  assert.equal(subtotalFill({ platform: 'Walmart', cancelled: false, merchandiseSubtotal: null }, { merchandiseSubtotal: 99.5 }), null);
  assert.equal(subtotalFill({ platform: 'Costco', cancelled: false, merchandiseSubtotal: null }, { merchandiseSubtotal: null }), null);
  assert.equal(subtotalFill({ platform: 'Costco', cancelled: false, merchandiseSubtotal: null }, {}), null);
});
