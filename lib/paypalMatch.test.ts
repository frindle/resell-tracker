import test from 'node:test';
import assert from 'node:assert/strict';
import { matchPayPalReceipt, paypalTxnIds, chargeCandidates, type PayPalOrder } from './paypalMatch.ts';
import type { PayPalReceipt } from './paypalReceipt.ts';

// Synthetic fixtures only.
const DAY = 24 * 60 * 60 * 1000;
const EMAIL_AT = '2026-11-15T18:00:00Z';
const NOW = Date.parse('2026-11-15T20:00:00Z');
const WAIT = 2 * DAY;
const ctx = { emailAt: EMAIL_AT, now: NOW, waitMs: WAIT };

const receipt = (over: Partial<PayPalReceipt> = {}): PayPalReceipt => ({
  merchant: 'Example Store Inc', amount: 123.45, date: '2026-11-15', network: 'Visa', last4: '4242', txnId: 'ABCDE12345FGHIJ67', ...over,
});

const order = (over: Partial<PayPalOrder> = {}): PayPalOrder => ({
  id: 1, platform: 'Example Store', cost: 123.45, taxAmount: null, shippingCost: 0,
  orderDate: '2026-11-14T10:00:00Z', createdAt: '2026-11-14T10:05:00Z', notes: null, cancelled: false, ...over,
});

test('a matching order is chosen', () => {
  assert.deepEqual(matchPayPalReceipt(receipt(), [order()], ctx), { action: 'apply', orderId: 1 });
});

test('the merchant must contain the platform, any case', () => {
  assert.equal(matchPayPalReceipt(receipt({ merchant: 'EXAMPLE STORE CORPORATION' }), [order()], ctx).action, 'apply');
  assert.equal(matchPayPalReceipt(receipt({ merchant: 'Other Shop' }), [order()], ctx).action, 'wait');
  assert.equal(matchPayPalReceipt(receipt(), [order({ platform: '' })], ctx).action, 'wait', 'an empty platform matches nothing');
});

test('the amount: cost, cost + tax, cost + tax + shipping, within two cents', () => {
  const o = order({ cost: 100, taxAmount: 8, shippingCost: 5 });
  assert.deepEqual(chargeCandidates(o), [100, 108, 113]);
  for (const [amount, expected] of [[100, 'apply'], [108, 'apply'], [113, 'apply'], [113.02, 'apply'], [99.98, 'apply'], [113.03, 'wait'], [110, 'wait']] as const) {
    assert.equal(matchPayPalReceipt(receipt({ amount }), [o], ctx).action, expected, String(amount));
  }
});

test('with no tax recorded, only cost and cost + shipping-free totals are tried', () => {
  const o = order({ cost: 100, taxAmount: null, shippingCost: 5 });
  assert.equal(matchPayPalReceipt(receipt({ amount: 100 }), [o], ctx).action, 'apply');
  assert.equal(matchPayPalReceipt(receipt({ amount: 105 }), [o], ctx).action, 'apply', 'cost + 0 tax + shipping');
});

test('the order date must be within 3 days of the receipt date', () => {
  assert.equal(matchPayPalReceipt(receipt(), [order({ orderDate: '2026-11-12T08:00:00Z' })], ctx).action, 'apply');
  assert.equal(matchPayPalReceipt(receipt(), [order({ orderDate: '2026-11-18T22:00:00Z' })], ctx).action, 'apply');
  assert.equal(matchPayPalReceipt(receipt(), [order({ orderDate: '2026-11-11T23:00:00Z' })], ctx).action, 'wait');
  assert.equal(matchPayPalReceipt(receipt(), [order({ orderDate: '2026-11-19T01:00:00Z' })], ctx).action, 'wait');
});

test('a receipt with no date uses the email date', () => {
  assert.equal(matchPayPalReceipt(receipt({ date: '' }), [order()], ctx).action, 'apply');
});

test('cancelled orders are not candidates', () => {
  assert.equal(matchPayPalReceipt(receipt(), [order({ cancelled: true })], ctx).action, 'wait');
});

test('an order that carries another PayPal transaction is skipped', () => {
  const taken = order({ id: 1, notes: 'PayPal: paid with Visa ending 1111 (transaction ZZZZZ99999YYYYY88)' });
  const free = order({ id: 2 });
  assert.deepEqual(matchPayPalReceipt(receipt(), [taken, free], ctx), { action: 'apply', orderId: 2 });
  assert.equal(matchPayPalReceipt(receipt(), [taken], ctx).action, 'wait');
});

test('an order whose notes carry this transaction means the receipt is done', () => {
  const done = order({ id: 7, notes: 'gift\nPayPal: paid with Visa ending 4242 (transaction abcde12345fghij67)' });
  assert.deepEqual(matchPayPalReceipt(receipt(), [order({ id: 8 }), done], ctx), { action: 'done', orderId: 7 });
});

test('done wins even when the order no longer fits the amount or date', () => {
  const done = order({ id: 7, cost: 5, orderDate: '2026-01-01T00:00:00Z', notes: 'PayPal: paid (transaction ABCDE12345FGHIJ67)' });
  assert.equal(matchPayPalReceipt(receipt(), [done], ctx).action, 'done');
});

test('two qualifying orders: the one created closest to the receipt time', () => {
  const early = order({ id: 1, createdAt: '2026-11-14T09:00:00Z' });
  const late = order({ id: 2, createdAt: '2026-11-15T17:00:00Z' });
  assert.deepEqual(matchPayPalReceipt(receipt(), [early, late], ctx), { action: 'apply', orderId: 2 });
  assert.deepEqual(matchPayPalReceipt(receipt(), [late, early], ctx), { action: 'apply', orderId: 2 });
  const before = order({ id: 3, createdAt: '2026-11-15T16:00:00Z' });
  const after = order({ id: 4, createdAt: '2026-11-15T21:00:00Z' });
  assert.equal((matchPayPalReceipt(receipt(), [after, before], ctx) as { orderId: number }).orderId, 3, 'two hours before beats three hours after');
});

test('an exact tie goes to the lower id', () => {
  const a = order({ id: 5 });
  const b = order({ id: 4 });
  assert.equal((matchPayPalReceipt(receipt(), [a, b], ctx) as { orderId: number }).orderId, 4);
});

test('no candidate: wait while the receipt is under 2 days old, then hold', () => {
  assert.deepEqual(matchPayPalReceipt(receipt(), [], ctx), { action: 'wait' });
  const justUnder = { ...ctx, now: Date.parse(EMAIL_AT) + WAIT };
  assert.equal(matchPayPalReceipt(receipt(), [], justUnder).action, 'wait');
  const over = { ...ctx, now: Date.parse(EMAIL_AT) + WAIT + 1 };
  assert.deepEqual(matchPayPalReceipt(receipt(), [], over), { action: 'no-matching-order' });
});

test('an undated email is held at once', () => {
  assert.equal(matchPayPalReceipt(receipt({ date: '' }), [], { ...ctx, emailAt: 'not a date' }).action, 'no-matching-order');
});

test('paypalTxnIds reads every transaction id in the notes', () => {
  assert.deepEqual(paypalTxnIds('a (transaction AAAAAA111111)\nPayPal: x (transaction bbbbbb222222)'), ['AAAAAA111111', 'BBBBBB222222']);
  assert.deepEqual(paypalTxnIds(null), []);
  assert.deepEqual(paypalTxnIds('nothing here'), []);
});
