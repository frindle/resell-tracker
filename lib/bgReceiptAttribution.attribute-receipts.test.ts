/**
 * Shortfall waterfall for BuyingGroup receipts on a shared tracking
 * (lib/bgReceiptAttribution.ts attributeReceipts).
 *
 * Bug: order 979 (expected 207.98) got 205.96... of a 507.95 receipt that
 * covers it in full, because a short receipt was spread proportionally over
 * the claimers. A short receipt must pay claimers in full, smallest
 * outstanding first (ties by lower id), until the receipt is used up.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

type Mod = typeof import('./bgReceiptAttribution.ts');
let _m: Mod | null = null;
async function mod(): Promise<Mod> {
  if (!_m) _m = (await import('./bgReceiptAttribution.ts')) as Mod;
  assert.equal(typeof (_m as unknown as Record<string, unknown>).attributeReceipts, 'function', 'lib/bgReceiptAttribution.ts must export attributeReceipts()');
  return _m;
}

const NOW = new Date('2026-10-01T12:00:00Z');
const CUTOFF = new Date(NOW.getTime() - 14 * 24 * 60 * 60 * 1000);
const T = '9339589752069224045820';
const T2 = '9400111899220000000002';
const T3 = '9400111899220000000003';

type O = {
  id: number; orderNumber: string | null; salePrice: number | null; bgExpectedPayout: number | null;
  trackingNumbers: string | null; buyer: { name: string } | null;
};
function order(p: Partial<O> & { id: number }): O {
  return { orderNumber: null, salePrice: null, bgExpectedPayout: null, trackingNumbers: null, buyer: { name: 'BuyingGroup' }, ...p };
}
function receipt(id: string, tracking: string, total: number): Record<string, unknown> {
  return { receipt_id: id, paid: true, status: 'paid', created_dt: '2026-09-28T00:00:00Z', order_number: '', total: String(total), tracking: { tracking_id: tracking } };
}
function opts() {
  return { creditedOnly: new Set<string>(), syncStartDate: null, cutoff: CUTOFF };
}
const cents = (x: number | undefined): number => Math.round((x ?? NaN) * 100) / 100;

function twoOrderCase(tReceiptTotal: number) {
  const a = order({ id: 979, bgExpectedPayout: 207.98, trackingNumbers: T });
  const b = order({ id: 975, bgExpectedPayout: 899.91, trackingNumbers: `${T}, ${T2}, ${T3}` });
  const receipts = [
    receipt('r-t2', T2, 300),
    receipt('r-t3', T3, 294.92),
    receipt('R-2613667932', T, tReceiptTotal),
  ];
  return { a, b, receipts };
}

test('short receipt covers the smaller claimer in full (order 979 gets 207.98, 975 gets 299.97)', async () => {
  const { attributeReceipts } = await mod();
  const { a, b, receipts } = twoOrderCase(507.95);
  const r = attributeReceipts([a, b], receipts, opts());
  assert.equal(r.paidAmountByOrder.get(979), 207.98);
  assert.equal(cents(r.paidAmountByOrder.get(975)), 894.89);
  assert.equal(cents((r.paidAmountByOrder.get(975) ?? 0) - 594.92), 299.97);
});

test('receipt that covers all claimers keeps the existing proportional behaviour', async () => {
  const { attributeReceipts } = await mod();
  const { a, b, receipts } = twoOrderCase(520);
  const r = attributeReceipts([a, b], receipts, opts());
  // 512.97 goes to the claimers by outstanding (207.98 / 304.99); the 7.03
  // surplus is then spread over both by outstanding (2.85 / 4.18).
  assert.equal(cents(r.paidAmountByOrder.get(979)), 210.83);
  assert.equal(cents(r.paidAmountByOrder.get(975)), cents(594.92 + 309.17));
  assert.equal(cents((r.paidAmountByOrder.get(979) ?? 0) + (r.paidAmountByOrder.get(975) ?? 0)), cents(594.92 + 520));
});

test('three orders sharing one tracking, outstanding 100/200/300, receipt 450 -> 100, 200, 150', async () => {
  const { attributeReceipts } = await mod();
  const o1 = order({ id: 1, bgExpectedPayout: 300, trackingNumbers: T });
  const o2 = order({ id: 2, bgExpectedPayout: 100, trackingNumbers: T });
  const o3 = order({ id: 3, bgExpectedPayout: 200, trackingNumbers: T });
  const r = attributeReceipts([o1, o2, o3], [receipt('r1', T, 450)], opts());
  assert.equal(r.paidAmountByOrder.get(2), 100);
  assert.equal(r.paidAmountByOrder.get(3), 200);
  assert.equal(r.paidAmountByOrder.get(1), 150);
  assert.equal(cents(['1', '2', '3'].reduce((s, k) => s + (r.paidAmountByOrder.get(Number(k)) ?? 0), 0)), 450);
});

test('equal outstanding 100 and receipt 150 -> lower id gets 100, the other 50', async () => {
  const { attributeReceipts } = await mod();
  const hi = order({ id: 20, bgExpectedPayout: 100, trackingNumbers: T });
  const lo = order({ id: 10, bgExpectedPayout: 100, trackingNumbers: T });
  const r = attributeReceipts([hi, lo], [receipt('r1', T, 150)], opts());
  assert.equal(r.paidAmountByOrder.get(10), 100);
  assert.equal(r.paidAmountByOrder.get(20), 50);
});
