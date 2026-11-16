import test from 'node:test';
import assert from 'node:assert/strict';
import { planBfmrCancel, type BfmrLine } from './bfmrCancelPlan.ts';

const ORDER = { id: 25, orderNumber: '111-2223334-4445556', cost: 1199.98 };
const line = (over: Partial<BfmrLine> = {}): BfmrLine => ({
  reserveId: 'R1', status: 'purchased', qty: 2, retailPrice: 599.99, bfmrOrderId: '111-2223334-4445556',
  links: [{ orderId: 25, quantity: 2 }], ...over,
});

test('everything matches: cancel it', () => {
  assert.deepEqual(planBfmrCancel(ORDER, [line()]), { cancel: ['R1'], left: [] });
  // Still only reserved, no order number yet; tax on top of retail is fine.
  assert.deepEqual(planBfmrCancel({ ...ORDER, cost: 1290 }, [line({ status: 'reserved', bfmrOrderId: null })]).cancel, ['R1']);
  // Order numbers compare without dashes or case.
  assert.deepEqual(planBfmrCancel({ ...ORDER, orderNumber: 'k000000001' }, [line({ bfmrOrderId: 'K000000001' })]).cancel, ['R1']);
});

test('a split reservation cancels only when every line is this order\'s', () => {
  const split = [line({ qty: 1, links: [{ orderId: 25, quantity: 1 }] }), line({ qty: 1, links: [{ orderId: 25, quantity: 1 }] })];
  assert.deepEqual(planBfmrCancel(ORDER, split).cancel, ['R1']);
  const shared = [line({ qty: 1, links: [{ orderId: 25, quantity: 1 }] }), line({ qty: 1, links: [{ orderId: 99, quantity: 1 }] })];
  assert.deepEqual(planBfmrCancel(ORDER, shared), { cancel: [], left: ['part of it is linked to another order'] });
  const unlinkedHalf = [line({ qty: 1, links: [{ orderId: 25, quantity: 1 }] }), line({ qty: 1, links: [] })];
  assert.deepEqual(planBfmrCancel(ORDER, unlinkedHalf).left, ['only 1 of 2 reserved units are this order\'s']);
});

test('mismatches stay open on BFMR with a reason', () => {
  assert.deepEqual(planBfmrCancel(ORDER, [line({ bfmrOrderId: '111-0000000-0000000' })]).left, ['BFMR has a different order number on it']);
  assert.deepEqual(planBfmrCancel(ORDER, [line({ bfmrOrderId: null })]).left, ['BFMR has it as purchased with no order number']);
  assert.deepEqual(planBfmrCancel(ORDER, [line({ status: 'shipped' })]).left, ['it is shipped on BFMR']);
  assert.deepEqual(planBfmrCancel(ORDER, [line({ status: 'paid' })]).cancel, []);
  assert.deepEqual(planBfmrCancel({ ...ORDER, cost: 599.99 }, [line()]).left, ['price doesn\'t match ($599.99 paid vs $1199.98 retail)']);
  assert.deepEqual(planBfmrCancel({ ...ORDER, cost: 0 }, [line()]).left, ['no price to compare']);
  assert.deepEqual(planBfmrCancel(ORDER, [line({ retailPrice: null })]).left, ['no price to compare']);
  assert.deepEqual(planBfmrCancel(ORDER, [line({ reserveId: null })]), { cancel: [], left: ['no BFMR reservation id on file'] });
});

test('two reservations: the price check uses their combined retail', () => {
  const two = [line(), line({ reserveId: 'R2', qty: 1, retailPrice: 400, bfmrOrderId: null, status: 'reserved', links: [{ orderId: 25, quantity: 1 }] })];
  assert.deepEqual(planBfmrCancel({ ...ORDER, cost: 1599.98 }, two).cancel, ['R1', 'R2']);
  assert.equal(planBfmrCancel(ORDER, two).cancel.length, 0);
});

test('no BFMR links: nothing to do', () => {
  assert.deepEqual(planBfmrCancel(ORDER, [line({ links: [{ orderId: 99, quantity: 2 }] })]), { cancel: [], left: [] });
});
