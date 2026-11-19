import test from 'node:test';
import assert from 'node:assert/strict';
import { matchPayPalReceipt, paypalTxnIds, PAYPAL_WAIT_MS, chargeCandidates, type PayPalOrder } from './paypalMatch.ts';
import type { PayPalReceipt } from './paypalReceipt.ts';

// Synthetic fixtures only.
const DAY = 24 * 60 * 60 * 1000;
const EMAIL_AT = '2026-11-15T18:00:00Z';
const NOW = Date.parse('2026-11-15T20:00:00Z');
const WAIT = PAYPAL_WAIT_MS;
const ctx = { emailAt: EMAIL_AT, now: NOW, waitMs: WAIT };

const receipt = (over: Partial<PayPalReceipt> = {}): PayPalReceipt => ({
  merchant: 'Example Store Inc', amount: 123.45, date: '2026-11-15', network: 'Visa', last4: '4242', txnId: 'ABCDE12345FGHIJ67', orderRef: '', ...over,
});

const order = (over: Partial<PayPalOrder> = {}): PayPalOrder => ({
  id: 1, platform: 'Example Store', cost: 123.45, taxAmount: null, shippingCost: 0,
  orderDate: '2026-11-14T10:00:00Z', createdAt: '2026-11-14T10:05:00Z', notes: null, cancelled: false, orderNumber: null, locked: false, ...over,
});

test('a matching order is chosen', () => {
  assert.deepEqual(matchPayPalReceipt(receipt(), [order()], ctx), { action: 'apply', orderId: 1 });
});

test('the merchant must contain the platform, any case', () => {
  assert.equal(matchPayPalReceipt(receipt({ merchant: 'EXAMPLE STORE CORPORATION' }), [order()], ctx).action, 'apply');
  assert.equal(matchPayPalReceipt(receipt({ merchant: 'Other Shop' }), [order()], ctx).action, 'hold');
  assert.equal(matchPayPalReceipt(receipt(), [order({ platform: '' })], ctx).action, 'hold', 'an empty platform matches nothing');
});

test('the amount: cost, cost + tax, cost + tax + shipping, within two cents', () => {
  const o = order({ cost: 100, taxAmount: 8, shippingCost: 5 });
  assert.deepEqual(chargeCandidates(o), [100, 108, 113]);
  for (const [amount, expected] of [[100, 'apply'], [108, 'apply'], [113, 'apply'], [113.02, 'apply'], [99.98, 'apply'], [113.03, 'hold'], [110, 'hold']] as const) {
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
  assert.equal(matchPayPalReceipt(receipt(), [order({ orderDate: '2026-11-11T23:00:00Z' })], ctx).action, 'hold');
  assert.equal(matchPayPalReceipt(receipt(), [order({ orderDate: '2026-11-19T01:00:00Z' })], ctx).action, 'hold');
});

test('a receipt with no date uses the email date', () => {
  assert.equal(matchPayPalReceipt(receipt({ date: '' }), [order()], ctx).action, 'apply');
});

test('cancelled orders are not candidates', () => {
  assert.equal(matchPayPalReceipt(receipt(), [order({ cancelled: true })], ctx).action, 'hold');
});

test('an order that carries another PayPal transaction is skipped', () => {
  const taken = order({ id: 1, notes: 'PayPal: paid with Visa ending 1111 (transaction ZZZZZ99999YYYYY88)' });
  const free = order({ id: 2 });
  assert.deepEqual(matchPayPalReceipt(receipt(), [taken, free], ctx), { action: 'apply', orderId: 2 });
  assert.equal(matchPayPalReceipt(receipt(), [taken], ctx).action, 'hold');
});

test('an order whose notes carry this transaction means the receipt is done', () => {
  const done = order({ id: 7, notes: 'gift\nPayPal: paid with Visa ending 4242 (transaction abcde12345fghij67)' });
  assert.deepEqual(matchPayPalReceipt(receipt(), [order({ id: 8 }), done], ctx), { action: 'done', orderId: 7 });
});

test('done wins even when the order no longer fits the amount or date', () => {
  const done = order({ id: 7, cost: 5, orderDate: '2026-01-01T00:00:00Z', notes: 'PayPal: paid (transaction ABCDE12345FGHIJ67)' });
  assert.equal(matchPayPalReceipt(receipt(), [done], ctx).action, 'done');
});

const NOW_ONLY = (over: object = {}) => ({ ...ctx, ...over });

test('two orders that both fit: hold as ambiguous, never pick the closest', () => {
  const a = order({ id: 1, createdAt: '2026-11-14T09:00:00Z' });
  const b = order({ id: 2, createdAt: '2026-11-15T17:00:00Z' });
  assert.deepEqual(matchPayPalReceipt(receipt(), [a, b], ctx), { action: 'hold', reason: 'ambiguous' });
  assert.deepEqual(matchPayPalReceipt(receipt(), [b, a], ctx), { action: 'hold', reason: 'ambiguous' });
});

test('several fits that are older than the wait are given up, not guessed', () => {
  const over = NOW_ONLY({ now: Date.parse(EMAIL_AT) + WAIT + 1 });
  assert.deepEqual(matchPayPalReceipt(receipt(), [order({ id: 1 }), order({ id: 2 })], over), { action: 'give-up' });
});

test('the order number on the receipt wins over merchant, amount and date', () => {
  const byNumber = order({ id: 1, orderNumber: '12-AB 345', cost: 999, platform: 'Elsewhere', orderDate: '2026-01-01T00:00:00Z' });
  const byFit = order({ id: 2 });
  assert.deepEqual(matchPayPalReceipt(receipt({ orderRef: '12ab345' }), [byFit, byNumber], ctx), { action: 'apply', orderId: 1 });
});

test('the order number matching two orders is ambiguous', () => {
  const a = order({ id: 1, orderNumber: 'W123456' });
  const b = order({ id: 2, orderNumber: 'w-123456' });
  assert.deepEqual(matchPayPalReceipt(receipt({ orderRef: 'W123456' }), [a, b], ctx), { action: 'hold', reason: 'ambiguous' });
});

test('an order number that matches nothing falls back to merchant, amount and date', () => {
  assert.deepEqual(matchPayPalReceipt(receipt({ orderRef: 'NOPE9999' }), [order({ id: 3, orderNumber: 'W1' })], ctx), { action: 'apply', orderId: 3 });
});

test('a too-short order number is not trusted', () => {
  const o = order({ id: 1, orderNumber: '12', cost: 1, orderDate: '2020-01-01T00:00:00Z' });
  assert.equal(matchPayPalReceipt(receipt({ orderRef: '12' }), [o], ctx).action, 'hold');
});

test('a locked order is never chosen: the receipt is held, then given up', () => {
  const locked = order({ id: 1, locked: true });
  assert.deepEqual(matchPayPalReceipt(receipt(), [locked], ctx), { action: 'hold', reason: 'locked-order' });
  assert.deepEqual(matchPayPalReceipt(receipt({ orderRef: 'W123456' }), [order({ id: 2, locked: true, orderNumber: 'W123456' })], ctx), { action: 'hold', reason: 'locked-order' });
  assert.equal(matchPayPalReceipt(receipt(), [locked], NOW_ONLY({ now: Date.parse(EMAIL_AT) + WAIT + 1 })).action, 'give-up');
});

test('a locked order that fits alongside an unlocked one is ambiguous, not skipped', () => {
  assert.deepEqual(matchPayPalReceipt(receipt(), [order({ id: 1, locked: true }), order({ id: 2 })], ctx), { action: 'hold', reason: 'ambiguous' });
});

test('no candidate: wait up to 7 days, then give up', () => {
  assert.deepEqual(matchPayPalReceipt(receipt(), [], ctx), { action: 'hold', reason: 'waiting-for-order' });
  assert.equal(WAIT, 7 * DAY);
  const justUnder = { ...ctx, now: Date.parse(EMAIL_AT) + WAIT };
  assert.equal(matchPayPalReceipt(receipt(), [], justUnder).action, 'hold');
  const over = { ...ctx, now: Date.parse(EMAIL_AT) + WAIT + 1 };
  assert.deepEqual(matchPayPalReceipt(receipt(), [], over), { action: 'give-up' });
});

test('an undated email is given up at once', () => {
  assert.equal(matchPayPalReceipt(receipt({ date: '' }), [], { ...ctx, emailAt: 'not a date' }).action, 'give-up');
});

test('paypalTxnIds reads every transaction id in the notes', () => {
  assert.deepEqual(paypalTxnIds('a (transaction AAAAAA111111)\nPayPal: x (transaction bbbbbb222222)'), ['AAAAAA111111', 'BBBBBB222222']);
  assert.deepEqual(paypalTxnIds(null), []);
  assert.deepEqual(paypalTxnIds('nothing here'), []);
});
