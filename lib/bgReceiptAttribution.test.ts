/**
 * Regression tests for BuyingGroup receipt -> order attribution
 * (lib/bgReceiptAttribution.ts, extracted from lib/bgSync.ts runBgReceiptSync).
 *
 * The bug (order 941): a CardCenter order (salePrice 158) carried a tracking
 * number that also belonged to BuyingGroup order 924 ($1199.99). The shared-
 * shipment split gave the CardCenter order 139.617 of 924's receipt and 924
 * only 1060.37 -- and the CardCenter sync, which owns that order's financial
 * fields, rewrote it back every 6h. CardCenter-buyer orders must take NO part
 * in BG receipt attribution.
 *
 * The remaining cases pin the existing attribution behaviour the extraction
 * must preserve (order-number precedence, fuzzy truncated match, weighted /
 * equal split, paid vs in-balance, returns, sync start date, overdue).
 *
 * Runs under plain `node --experimental-strip-types --test` (no @/ alias).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

type Mod = typeof import('./bgReceiptAttribution.ts');
let _m: Mod | null = null;
async function mod(): Promise<Mod> {
  if (!_m) _m = (await import('./bgReceiptAttribution.ts')) as Mod;
  for (const k of ['attributeReceipts', 'isCardCenterBuyer', 'normalizeDigits']) {
    assert.equal(typeof (_m as unknown as Record<string, unknown>)[k], 'function', `lib/bgReceiptAttribution.ts must export ${k}()`);
  }
  return _m;
}

const NOW = new Date('2026-10-01T12:00:00Z');
const CUTOFF = new Date(NOW.getTime() - 14 * 24 * 60 * 60 * 1000);
const T = '9400111899223344556677';
const T2 = '9400111899220000000001';

type O = {
  id: number; orderNumber: string | null; salePrice: number | null; bgExpectedPayout: number | null;
  trackingNumbers: string | null; buyer: { name: string } | null;
};
function order(p: Partial<O> & { id: number }): O {
  return { orderNumber: null, salePrice: null, bgExpectedPayout: null, trackingNumbers: null, buyer: { name: 'BuyingGroup' }, ...p };
}
function receipt(p: Record<string, unknown>): Record<string, unknown> {
  return { receipt_id: 'r' + Math.random(), paid: true, status: 'paid', created_dt: '2026-09-28T00:00:00Z', order_number: '', ...p };
}
function opts(p: Partial<{ creditedOnly: Set<string>; syncStartDate: Date | null; cutoff: Date }> = {}) {
  return { creditedOnly: new Set<string>(), syncStartDate: null, cutoff: CUTOFF, ...p };
}
const near = (a: number | undefined, b: number, msg: string) =>
  assert.ok(a !== undefined && Math.abs(a - b) < 1e-6, `${msg}: expected ${b}, got ${a}`);

test('THE 941 BUG: BG order + CardCenter order share a tracking -> BG order gets the full 1199.99, CardCenter order gets nothing', async () => {
  const { attributeReceipts } = await mod();
  const bg = order({ id: 924, orderNumber: '111-0000000-0000924', salePrice: 1199.99, trackingNumbers: T });
  const cc = order({ id: 941, orderNumber: '1234567890123456789012', salePrice: 158, trackingNumbers: `${T}, 1Z999AA10123456784`, buyer: { name: 'CardCenter' } });
  const r = attributeReceipts([bg, cc], [receipt({ receipt_id: 'r924', total: '1199.99', tracking: { tracking_id: T } })], opts());
  near(r.paidAmountByOrder.get(924), 1199.99, 'paidAmountByOrder[924]');
  near(r.inBalanceAmountByOrder.get(924), 1199.99, 'inBalanceAmountByOrder[924]');
  assert.equal(r.paidAmountByOrder.has(941), false, `CardCenter order must get no paid share, got ${r.paidAmountByOrder.get(941)}`);
  assert.equal(r.inBalanceAmountByOrder.has(941), false, 'CardCenter order must get no in-balance share');
  assert.equal(r.bgMatchedOrderIds.has(941), false, 'CardCenter order must not be BG-matched');
  assert.equal(r.creditedTrackingsByOrder.has(941), false, 'CardCenter order must not get credited trackings');
  assert.ok(r.bgMatchedOrderIds.has(924));
  assert.deepEqual([...(r.creditedTrackingsByOrder.get(924) ?? [])], [T]);
});

test('CardCenter order is ignored even when the receipt carries ITS order number', async () => {
  const { attributeReceipts } = await mod();
  const cc = order({ id: 7, orderNumber: '222-3333333-4444444', salePrice: 50, buyer: { name: 'cardcenter' } });
  const r = attributeReceipts([cc], [receipt({ order_number: '222-3333333-4444444', total: '50', status: 'pending', paid: false, created_dt: '2026-01-01T00:00:00Z' })], opts());
  assert.equal(r.paidAmountByOrder.size + r.inBalanceAmountByOrder.size + r.bgMatchedOrderIds.size + r.receiptOverdueIds.size, 0);
});

test('isCardCenterBuyer: CardCenter in any casing / spacing; not BG, BFMR, null', async () => {
  const { isCardCenterBuyer } = await mod();
  for (const n of ['CardCenter', 'cardcenter', 'Card Center', 'CARDCENTER (gift cards)']) assert.equal(isCardCenterBuyer(n), true, n);
  for (const n of ['BuyingGroup', 'BFMR', 'Card Cent', '', null, undefined]) assert.equal(isCardCenterBuyer(n as string | null | undefined), false, String(n));
});

test('combined shipment of two BG orders splits by bgExpectedPayout ?? salePrice', async () => {
  const { attributeReceipts } = await mod();
  const a = order({ id: 1, bgExpectedPayout: 300, salePrice: 999, trackingNumbers: T });
  const b = order({ id: 2, bgExpectedPayout: null, salePrice: 100, trackingNumbers: T });
  const r = attributeReceipts([a, b], [receipt({ total: '400', tracking: { tracking_id: T } })], opts());
  near(r.paidAmountByOrder.get(1), 300, 'order 1 share');
  near(r.paidAmountByOrder.get(2), 100, 'order 2 share');
  near(r.inBalanceAmountByOrder.get(2), 100, 'order 2 in-balance share');
});

test('combined shipment with no dollar signal at all splits equally', async () => {
  const { attributeReceipts } = await mod();
  const a = order({ id: 1, trackingNumbers: T });
  const b = order({ id: 2, trackingNumbers: `${T2},${T}` });
  const r = attributeReceipts([a, b], [receipt({ total: '400', tracking: { tracking_id: T } })], opts());
  near(r.paidAmountByOrder.get(1), 200, 'order 1 share');
  near(r.paidAmountByOrder.get(2), 200, 'order 2 share');
});

test('order-number match beats tracking match and accumulates across receipts', async () => {
  const { attributeReceipts } = await mod();
  const a = order({ id: 1, orderNumber: '111-2222222-3333333', salePrice: 100, trackingNumbers: T });
  const b = order({ id: 2, orderNumber: '999-8888888-7777777', salePrice: 100, trackingNumbers: T });
  const r = attributeReceipts([a, b], [
    receipt({ order_number: '11122222223333333', total: '60', tracking: { tracking_id: T } }),
    receipt({ order_number: '111-2222222-3333333', total: '40', tracking: { tracking_id: T2 } }),
  ], opts());
  near(r.paidAmountByOrder.get(1), 100, 'order 1 total');
  near(r.inBalanceAmountByOrder.get(1), 100, 'order 1 in-balance total');
  assert.ok(r.bgMatchedOrderIds.has(1), 'order-number match marks the order BG-matched');
  assert.equal(r.bgMatchedOrderIds.has(2), false);
  assert.equal(r.paidAmountByOrder.has(2), false, 'order-number match must not also split by tracking');
  assert.deepEqual([...(r.creditedTrackingsByOrder.get(1) ?? [])].sort(), [T2, T].sort());
});

test('fuzzy match: BG portal dropped the trailing digit of the order number', async () => {
  const { attributeReceipts } = await mod();
  const a = order({ id: 1, orderNumber: '200014866331820', salePrice: 80 });
  const r = attributeReceipts([a], [receipt({ order_number: '20001486633182', total: '80' })], opts());
  near(r.paidAmountByOrder.get(1), 80, 'fuzzy-matched order');
});

test('fuzzy match is dropped when two orders truncate to the same number (ambiguous)', async () => {
  const { attributeReceipts } = await mod();
  const a = order({ id: 1, orderNumber: '200014866331820', salePrice: 80 });
  const b = order({ id: 2, orderNumber: '200014866331829', salePrice: 80 });
  const r = attributeReceipts([a, b], [receipt({ order_number: '20001486633182', total: '80' })], opts());
  assert.equal(r.paidAmountByOrder.size, 0, `ambiguous truncation must match nothing, got ${JSON.stringify([...r.paidAmountByOrder])}`);
});

test('short order numbers (< 8 digits) get no fuzzy form', async () => {
  const { attributeReceipts } = await mod();
  const a = order({ id: 1, orderNumber: '1234567', salePrice: 5 });
  const r = attributeReceipts([a], [receipt({ order_number: '123456', total: '5' })], opts());
  assert.equal(r.paidAmountByOrder.size, 0);
});

test('creditedOnly receipt: in balance but NOT truly paid; verified counts in balance only', async () => {
  const { attributeReceipts } = await mod();
  const a = order({ id: 1, salePrice: 100, trackingNumbers: T });
  const b = order({ id: 2, salePrice: 100, trackingNumbers: T2 });
  const r = attributeReceipts([a, b], [
    receipt({ receipt_id: 'held', total: '100', tracking: { tracking_id: T } }),
    receipt({ receipt_id: 'v', paid: false, status: 'Verified', total: '100', tracking: { tracking_id: T2 } }),
  ], opts({ creditedOnly: new Set(['held']) }));
  assert.equal(r.paidAmountByOrder.has(1), false, 'creditedOnly receipt must not count as paid');
  near(r.inBalanceAmountByOrder.get(1), 100, 'creditedOnly receipt is in balance');
  assert.equal(r.paidAmountByOrder.has(2), false, 'verified receipt is not paid');
  near(r.inBalanceAmountByOrder.get(2), 100, 'verified receipt is in balance');
  assert.ok(r.creditedTrackingsByOrder.get(2)?.has(T2));
});

test('return/refund receipts never count; they never mark overdue either', async () => {
  const { attributeReceipts } = await mod();
  const a = order({ id: 1, salePrice: 100, trackingNumbers: T });
  const r = attributeReceipts([a], [
    receipt({ status: 'Refunded', total: '100', tracking: { tracking_id: T }, created_dt: '2026-01-01T00:00:00Z' }),
    receipt({ status: 'return', paid: false, total: '100', tracking: { tracking_id: T }, created_dt: '2026-01-01T00:00:00Z' }),
  ], opts());
  assert.equal(r.paidAmountByOrder.has(1), false);
  assert.equal(r.inBalanceAmountByOrder.has(1), false);
  assert.equal(r.receiptOverdueIds.has(1), false);
  assert.ok(r.bgMatchedOrderIds.has(1), 'a matched return receipt still marks the order BG-matched');
});

test('unpaid receipt older than cutoff marks overdue; newer one does not (tracking + order-number + shared paths)', async () => {
  const { attributeReceipts } = await mod();
  const old = '2026-09-01T00:00:00Z';
  const fresh = '2026-09-30T00:00:00Z';
  const orders = [
    order({ id: 1, trackingNumbers: T }),
    order({ id: 2, orderNumber: '555-5555555-5555555' }),
    order({ id: 3, trackingNumbers: T2 }), order({ id: 4, trackingNumbers: T2 }),
    order({ id: 5, trackingNumbers: '9400000000000000000005' }),
  ];
  const r = attributeReceipts(orders, [
    receipt({ paid: false, status: 'pending', created_dt: old, tracking: { tracking_id: T } }),
    receipt({ paid: false, status: 'pending', created_dt: old, order_number: '555-5555555-5555555' }),
    receipt({ paid: false, status: 'pending', created_dt: old, tracking: { tracking_id: T2 } }),
    receipt({ paid: false, status: 'pending', created_dt: fresh, tracking: { tracking_id: '9400000000000000000005' } }),
  ], opts());
  assert.deepEqual([...r.receiptOverdueIds].sort(), [1, 2, 3, 4]);
});

test('receipts created before syncStartDate are ignored', async () => {
  const { attributeReceipts } = await mod();
  const a = order({ id: 1, salePrice: 100, trackingNumbers: T });
  const r = attributeReceipts([a], [
    receipt({ total: '70', created_dt: '2026-08-01T00:00:00Z', tracking: { tracking_id: T } }),
    receipt({ total: '30', created_dt: '2026-09-15T00:00:00Z', tracking: { tracking_id: T } }),
  ], opts({ syncStartDate: new Date('2026-09-01T00:00:00Z') }));
  near(r.paidAmountByOrder.get(1), 30, 'only the post-start receipt counts');
});

test('receipt with neither order-number nor tracking match is ignored; normalizeDigits strips non-digits', async () => {
  const { attributeReceipts, normalizeDigits } = await mod();
  const a = order({ id: 1, salePrice: 100, trackingNumbers: T });
  const r = attributeReceipts([a], [receipt({ total: '100', tracking: { tracking_id: '1Z' } }), receipt({ total: '100' })], opts());
  assert.equal(r.bgMatchedOrderIds.size, 0);
  assert.equal(normalizeDigits('111-22 33x'), '1112233');
  assert.equal(normalizeDigits(null), '');
});

test('8-digit order number still gets a fuzzy (trailing-digit-dropped) form', async () => {
  const { attributeReceipts } = await mod();
  const a = order({ id: 1, orderNumber: '12345678', salePrice: 5 });
  const r = attributeReceipts([a], [receipt({ order_number: '1234567', total: '5' })], opts());
  near(r.paidAmountByOrder.get(1), 5, '8-digit fuzzy match');
});

test('exact order-number match wins over a fuzzy candidate for the same digits', async () => {
  const { attributeReceipts } = await mod();
  // Y first: its truncated form 12345678 is registered before X's full 12345678 exists.
  const y = order({ id: 2, orderNumber: '123456789', salePrice: 5 });
  const x = order({ id: 1, orderNumber: '12345678', salePrice: 5 });
  const r = attributeReceipts([y, x], [receipt({ order_number: '12345678', total: '5' })], opts());
  near(r.paidAmountByOrder.get(1), 5, 'exact match');
  assert.equal(r.paidAmountByOrder.has(2), false, 'fuzzy candidate must not steal an exact match');
});

test('tracking numbers are digit-normalised on BOTH sides (formatted receipt + formatted order list)', async () => {
  const { attributeReceipts } = await mod();
  const a = order({ id: 1, salePrice: 10, trackingNumbers: '9400 1118 9922 0000 0000 01' });
  const b = order({ id: 2, salePrice: 10, trackingNumbers: '9400-0000-0000-0000-0000-77' });
  const r = attributeReceipts([a, b], [
    receipt({ total: '10', tracking: { tracking_id: T2 } }),
    receipt({ total: '10', tracking: { tracking_id: '9400 0000 0000 0000 0000 77' } }),
  ], opts());
  near(r.paidAmountByOrder.get(1), 10, 'formatted order tracking');
  near(r.paidAmountByOrder.get(2), 10, 'formatted receipt tracking');
});

test('order-number path: non-in-balance receipt adds nothing; creditedOnly is in balance but unpaid; paid-old receipt is not overdue', async () => {
  const { attributeReceipts } = await mod();
  const a = order({ id: 1, orderNumber: '111-0000000-0000001', salePrice: 100 });
  const b = order({ id: 2, orderNumber: '111-0000000-0000002', salePrice: 100 });
  const c = order({ id: 3, orderNumber: '111-0000000-0000003', salePrice: 100 });
  const r = attributeReceipts([a, b, c], [
    receipt({ order_number: '111-0000000-0000001', paid: false, status: 'pending', total: '100', created_dt: '2026-09-30T00:00:00Z', tracking: { tracking_id: T } }),
    receipt({ receipt_id: 'held', order_number: '111-0000000-0000002', total: '100', created_dt: '2026-01-01T00:00:00Z', tracking: { tracking_id: T2 } }),
    receipt({ order_number: '111-0000000-0000003', total: '100', created_dt: '2026-01-01T00:00:00Z' }),
  ], opts({ creditedOnly: new Set(['held']) }));
  assert.ok(r.bgMatchedOrderIds.has(1));
  assert.equal(r.inBalanceAmountByOrder.has(1), false, 'pending receipt is not in balance');
  assert.equal(r.paidAmountByOrder.has(1), false, 'pending receipt is not paid');
  assert.equal(r.creditedTrackingsByOrder.has(1), false, 'pending receipt credits no tracking');
  assert.equal(r.receiptOverdueIds.has(1), false, 'fresh pending receipt is not overdue');
  near(r.inBalanceAmountByOrder.get(2), 100, 'creditedOnly in balance');
  assert.equal(r.paidAmountByOrder.has(2), false, 'creditedOnly not paid');
  assert.deepEqual([...(r.creditedTrackingsByOrder.get(2) ?? [])], [T2]);
  assert.equal(r.receiptOverdueIds.has(2), false, 'old in-balance receipt is not overdue');
  assert.equal(r.receiptOverdueIds.has(3), false, 'old paid receipt is not overdue');
  near(r.paidAmountByOrder.get(3), 100, 'paid via order number');
});

test('shared-tracking path: pending receipt adds nothing; paid-old not overdue; in-balance credits the tracking to every sharer', async () => {
  const { attributeReceipts } = await mod();
  const a = order({ id: 1, salePrice: 100, trackingNumbers: T });
  const b = order({ id: 2, salePrice: 100, trackingNumbers: T });
  const c = order({ id: 3, salePrice: 100, trackingNumbers: T2 });
  const d = order({ id: 4, salePrice: 100, trackingNumbers: T2 });
  const r = attributeReceipts([a, b, c, d], [
    receipt({ paid: false, status: 'pending', total: '200', created_dt: '2026-09-30T00:00:00Z', tracking: { tracking_id: T } }),
    receipt({ receipt_id: 'held', total: '200', created_dt: '2026-01-01T00:00:00Z', tracking: { tracking_id: T2 } }),
  ], opts({ creditedOnly: new Set(['held']) }));
  for (const id of [1, 2]) {
    assert.ok(r.bgMatchedOrderIds.has(id));
    assert.equal(r.inBalanceAmountByOrder.has(id), false, `order ${id}: pending is not in balance`);
    assert.equal(r.paidAmountByOrder.has(id), false, `order ${id}: pending is not paid`);
    assert.equal(r.creditedTrackingsByOrder.has(id), false, `order ${id}: pending credits nothing`);
    assert.equal(r.receiptOverdueIds.has(id), false, `order ${id}: fresh pending is not overdue`);
  }
  for (const id of [3, 4]) {
    near(r.inBalanceAmountByOrder.get(id), 100, `order ${id} in-balance share`);
    assert.equal(r.paidAmountByOrder.has(id), false, `order ${id}: creditedOnly is not paid`);
    assert.deepEqual([...(r.creditedTrackingsByOrder.get(id) ?? [])], [T2]);
    assert.equal(r.receiptOverdueIds.has(id), false, `order ${id}: old in-balance is not overdue`);
  }
});

test('single-tracking path: old PAID receipt is not overdue; pending receipt credits nothing', async () => {
  const { attributeReceipts } = await mod();
  const a = order({ id: 1, salePrice: 100, trackingNumbers: T });
  const b = order({ id: 2, salePrice: 100, trackingNumbers: T2 });
  const r = attributeReceipts([a, b], [
    receipt({ total: '100', created_dt: '2026-01-01T00:00:00Z', tracking: { tracking_id: T } }),
    receipt({ paid: false, status: 'pending', total: '100', created_dt: '2026-09-30T00:00:00Z', tracking: { tracking_id: T2 } }),
  ], opts());
  assert.equal(r.receiptOverdueIds.has(1), false);
  near(r.paidAmountByOrder.get(1), 100, 'paid');
  assert.ok(r.bgMatchedOrderIds.has(2));
  assert.equal(r.creditedTrackingsByOrder.has(2), false, 'pending receipt credits no tracking');
  assert.equal(r.inBalanceAmountByOrder.has(2), false, 'pending receipt is not in balance');
});

test('overdue boundary: a receipt created exactly AT cutoff is not overdue (all three paths)', async () => {
  const { attributeReceipts } = await mod();
  const at = CUTOFF.toISOString();
  const r = attributeReceipts([
    order({ id: 1, trackingNumbers: T }),
    order({ id: 2, orderNumber: '555-5555555-5555555' }),
    order({ id: 3, trackingNumbers: T2 }), order({ id: 4, trackingNumbers: T2 }),
  ], [
    receipt({ paid: false, status: 'pending', created_dt: at, tracking: { tracking_id: T } }),
    receipt({ paid: false, status: 'pending', created_dt: at, order_number: '555-5555555-5555555' }),
    receipt({ paid: false, status: 'pending', created_dt: at, tracking: { tracking_id: T2 } }),
  ], opts());
  assert.deepEqual([...r.receiptOverdueIds], []);
});

test('syncStartDate boundary: a receipt created exactly AT the start date counts', async () => {
  const { attributeReceipts } = await mod();
  const start = new Date('2026-09-01T00:00:00Z');
  const a = order({ id: 1, salePrice: 100, trackingNumbers: T });
  const r = attributeReceipts([a], [receipt({ total: '40', created_dt: start.toISOString(), tracking: { tracking_id: T } })], opts({ syncStartDate: start }));
  near(r.paidAmountByOrder.get(1), 40, 'receipt at start date');
});

test('missing / unparseable receipt total counts as 0 (order still matched)', async () => {
  const { attributeReceipts } = await mod();
  const a = order({ id: 1, salePrice: 100, trackingNumbers: T });
  const b = order({ id: 2, salePrice: 100, trackingNumbers: T2 });
  const r = attributeReceipts([a, b], [
    receipt({ total: undefined, tracking: { tracking_id: T } }),
    receipt({ total: 'n/a', tracking: { tracking_id: T2 } }),
  ], opts());
  near(r.paidAmountByOrder.get(1), 0, 'missing total');
  near(r.paidAmountByOrder.get(2), 0, 'unparseable total');
});

test('combined shipment: an order with no dollar signal gets weight 0 when another sharer has one', async () => {
  const { attributeReceipts } = await mod();
  const a = order({ id: 1, bgExpectedPayout: 300, trackingNumbers: T });
  const b = order({ id: 2, trackingNumbers: T });
  const r = attributeReceipts([a, b], [receipt({ total: '400', tracking: { tracking_id: T } })], opts());
  near(r.paidAmountByOrder.get(1), 400, 'weighted order takes all');
  near(r.paidAmountByOrder.get(2), 0, 'no-signal order takes 0');
});

test('combined shipment: sub-dollar weights still split by weight, not equally', async () => {
  const { attributeReceipts } = await mod();
  const a = order({ id: 1, bgExpectedPayout: 0.6, trackingNumbers: T });
  const b = order({ id: 2, bgExpectedPayout: 0.2, trackingNumbers: T });
  const r = attributeReceipts([a, b], [receipt({ total: '8', tracking: { tracking_id: T } })], opts());
  near(r.paidAmountByOrder.get(1), 6, 'weight 0.6 of 0.8');
  near(r.paidAmountByOrder.get(2), 2, 'weight 0.2 of 0.8');
});
