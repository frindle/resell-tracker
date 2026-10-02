/**
 * Which orders the Amazon missing-tracking backfill may target
 * (lib/missingTrackingBackfill.ts, used by app/api/orders/missing-tracking).
 *
 * The bug (order 941): a Costco order (22-digit order number) that had once
 * been saved as platform Amazon was returned by the backfill, the sidecar
 * scraped Amazon's order-details page for that number, and three OTHER orders'
 * tracking numbers were attached to it. Penn's rule (2026-10-01): the backfill
 * looks at ALL PENDING orders and SKIPS anything already processed or paid up
 * to the full sale price; and only Amazon-shaped order numbers are returned.
 *
 * Runs under plain `node --experimental-strip-types --test` (no @/ alias).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

type Mod = typeof import('./missingTrackingBackfill.ts');
let _m: Mod | null = null;
async function mod(): Promise<Mod> {
  if (!_m) _m = (await import('./missingTrackingBackfill.ts')) as Mod;
  for (const k of ['isAmazonOrderNumber', 'isPaidInFull', 'isProcessed', 'isPendingForTrackingBackfill', 'missingTrackingWhere', 'selectBackfillOrderNumbers']) {
    assert.equal(typeof (_m as unknown as Record<string, unknown>)[k], 'function', `lib/missingTrackingBackfill.ts must export ${k}()`);
  }
  return _m;
}

type Row = {
  orderNumber: string | null; trackingNumbers: string | null; cancelled: boolean; lost: boolean;
  salePriceSynced: boolean; salePrice: number | null; bgExpectedPayout: number | null;
  bgPaidAmount: number | null; bgCredited: boolean; bfmrStatus: string | null;
};
function row(p: Partial<Row> = {}): Row {
  return {
    orderNumber: '111-1234567-1234567', trackingNumbers: null, cancelled: false, lost: false,
    salePriceSynced: false, salePrice: 100, bgExpectedPayout: null, bgPaidAmount: null,
    bgCredited: false, bfmrStatus: null, ...p,
  };
}

test('THE 941 BUG: a Costco 22-digit order number is never a backfill target', async () => {
  const { isPendingForTrackingBackfill, selectBackfillOrderNumbers } = await mod();
  const costco = row({ orderNumber: '1234567890123456789012', salePrice: 158, bgPaidAmount: 139.617 });
  assert.equal(isPendingForTrackingBackfill(costco), false);
  assert.deepEqual(selectBackfillOrderNumbers([costco, row()]), ['111-1234567-1234567']);
});

test('isAmazonOrderNumber: physical 3-7-7 and digital D01-7-7 only', async () => {
  const { isAmazonOrderNumber } = await mod();
  for (const n of ['111-1234567-1234567', '702-0000000-9999999', 'D01-1234567-1234567', 'D99-0000000-0000000']) {
    assert.equal(isAmazonOrderNumber(n), true, n);
  }
  for (const n of [
    '1234567890123456789012', '11112345671234567', '111-1234567-12345678', '1111-1234567-1234567',
    '111-123456-1234567', ' 111-1234567-1234567', '111-1234567-1234567 ', 'X01-1234567-1234567',
    'D1-1234567-1234567', 'd01-1234567-1234567', '200014866331820', 'W123-1234567-1234567', '', null, undefined,
  ]) {
    assert.equal(isAmazonOrderNumber(n as string | null | undefined), false, String(n));
  }
});

test('pending Amazon-shaped order with no tracking IS a target (no buyer / partial payment still pending)', async () => {
  const { isPendingForTrackingBackfill } = await mod();
  assert.equal(isPendingForTrackingBackfill(row()), true, 'plain pending');
  assert.equal(isPendingForTrackingBackfill(row({ orderNumber: 'D01-1234567-1234567' })), true, 'digital');
  assert.equal(isPendingForTrackingBackfill(row({ bgPaidAmount: 50 })), true, 'partially paid (50 of 100)');
  assert.equal(isPendingForTrackingBackfill(row({ bgPaidAmount: 99.98 })), true, 'short by 2 cents');
  assert.equal(isPendingForTrackingBackfill(row({ bgPaidAmount: 0 })), true, 'zero paid');
  assert.equal(isPendingForTrackingBackfill(row({ salePrice: null, bgPaidAmount: 40 })), true, 'paid but no expected amount = partial');
  assert.equal(isPendingForTrackingBackfill(row({ bfmrStatus: 'reserved' })), true, 'non-processed BFMR status');
  assert.equal(isPendingForTrackingBackfill(row({ trackingNumbers: '' })), true, 'empty-string tracking counts as missing');
});

test('paid in full is NOT a target: salePriceSynced, or bgPaidAmount >= (bgExpectedPayout ?? salePrice) - 0.01', async () => {
  const { isPendingForTrackingBackfill, isPaidInFull } = await mod();
  const cases: Array<[string, Partial<Row>]> = [
    ['salePriceSynced', { salePriceSynced: true }],
    ['paid == salePrice', { bgPaidAmount: 100 }],
    ['paid over salePrice', { bgPaidAmount: 120 }],
    ['within 1 cent tolerance', { bgPaidAmount: 99.995 }],
    ['paid == bgExpectedPayout (below salePrice)', { bgExpectedPayout: 90, bgPaidAmount: 90 }],
    ['exactly 1 cent short (boundary), sub-dollar amounts', { salePrice: 0.51, bgPaidAmount: 0.5 }],
  ];
  for (const [name, p] of cases) {
    assert.equal(isPaidInFull(row(p)), true, `isPaidInFull: ${name}`);
    assert.equal(isPendingForTrackingBackfill(row(p)), false, name);
  }
  assert.equal(isPaidInFull(row({ bgExpectedPayout: 130, bgPaidAmount: 120 })), false, 'bgExpectedPayout wins over salePrice as the expected amount');
  assert.equal(isPaidInFull(row({ salePrice: 0, bgPaidAmount: 0 })), false, 'nothing paid is never paid-in-full');
  assert.equal(isPaidInFull(row({ salePrice: null, bgExpectedPayout: null, bgPaidAmount: 40 })), false, 'no expected amount = not paid in full');
});

test('processed is NOT a target: bgCredited, or a processed-type BFMR status (any case)', async () => {
  const { isPendingForTrackingBackfill, isProcessed } = await mod();
  assert.equal(isProcessed(row({ bgCredited: true })), true);
  assert.equal(isPendingForTrackingBackfill(row({ bgCredited: true })), false, 'bgCredited');
  for (const s of ['processed', 'Processed', 'PAID', 'received', 'pkg_received', 'payment_sent', 'completed']) {
    assert.equal(isProcessed(row({ bfmrStatus: s })), true, s);
    assert.equal(isPendingForTrackingBackfill(row({ bfmrStatus: s })), false, s);
  }
  for (const s of ['reserved', 'shipped', '', null]) assert.equal(isProcessed(row({ bfmrStatus: s })), false, String(s));
});

test('cancelled, lost, already-tracked or numberless orders are not targets', async () => {
  const { isPendingForTrackingBackfill } = await mod();
  assert.equal(isPendingForTrackingBackfill(row({ cancelled: true })), false, 'cancelled');
  assert.equal(isPendingForTrackingBackfill(row({ lost: true })), false, 'lost');
  assert.equal(isPendingForTrackingBackfill(row({ trackingNumbers: '1Z999AA10123456784' })), false, 'has tracking');
  assert.equal(isPendingForTrackingBackfill(row({ orderNumber: null })), false, 'no order number');
});

test('selectBackfillOrderNumbers: filters, de-duplicates, keeps row order', async () => {
  const { selectBackfillOrderNumbers } = await mod();
  const out = selectBackfillOrderNumbers([
    row({ orderNumber: '222-2222222-2222222' }),
    row({ orderNumber: '111-1111111-1111111', salePriceSynced: true }),
    row({ orderNumber: 'D01-1111111-1111111' }),
    row({ orderNumber: '222-2222222-2222222' }),
    row({ orderNumber: '1234567890123456789012' }),
  ]);
  assert.deepEqual(out, ['222-2222222-2222222', 'D01-1111111-1111111']);
});

test('missingTrackingWhere: coarse pre-filter, 60-day window, NO platform filter', async () => {
  const { missingTrackingWhere } = await mod();
  const now = new Date('2026-10-01T12:00:00Z');
  const w = missingTrackingWhere(7, now) as Record<string, unknown>;
  assert.deepEqual(w, {
    userId: 7,
    cancelled: false,
    lost: false,
    salePriceSynced: false,
    orderDate: { gte: new Date('2026-08-02T12:00:00Z') },
    orderNumber: { not: null },
    OR: [{ trackingNumbers: null }, { trackingNumbers: '' }],
  });
});
