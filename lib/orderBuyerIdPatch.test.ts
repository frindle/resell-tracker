import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveOrderPatchDecision, ORDER_PATCHABLE_FIELDS } from './orderFieldSync.ts';

test('buyerId is patchable (moving an order between BFMR Buyer groups)', () => {
  assert.deepEqual(resolveOrderPatchDecision({ buyerId: 5 }), { reject: false, patchKeys: ['buyerId'], isCashbackOnlyCorrection: false });
});

test('buyerId: null still counts as a patch key (unassign, not dropped)', () => {
  const d = resolveOrderPatchDecision({ buyerId: null });
  assert.equal(d.reject, false);
  assert.deepEqual(d.patchKeys, ['buyerId']);
});

test('unknown-only body is still rejected', () => {
  assert.deepEqual(resolveOrderPatchDecision({ id: 9, userId: 2, bogusField: 1 }), { reject: true, patchKeys: [], isCashbackOnlyCorrection: false });
});

test('allow-list is the 18 prior fields plus exactly buyerId', () => {
  assert.equal(ORDER_PATCHABLE_FIELDS.size, 19);
  for (const f of ['salePriceSynced', 'overdueAt', 'deliveryDeadline', 'trackingNumbers', 'trackingValues', 'notes', 'bgExpectedPayout', 'lost', 'salePrice', 'bfmrStatus', 'cost', 'shippingCost', 'insuranceCost', 'cashbackAmount', 'portalCashback', 'itemDescription', 'shippingAddress', 'cardId', 'buyerId']) {
    assert.ok(ORDER_PATCHABLE_FIELDS.has(f), f);
  }
});

test('cashback-only lock exemption stays scoped to cashbackAmount alone', () => {
  assert.equal(resolveOrderPatchDecision({ buyerId: 3 }).isCashbackOnlyCorrection, false);
  assert.equal(resolveOrderPatchDecision({ cashbackAmount: 1, buyerId: 3 }).isCashbackOnlyCorrection, false);
  assert.equal(resolveOrderPatchDecision({ cashbackAmount: 1 }).isCashbackOnlyCorrection, true);
});
