import test from 'node:test';
import assert from 'node:assert/strict';
import { planBgReduce, bgStateFrom, bgOutcomeLine, cancelledItem, planPartialCancel, planBfmrPartial, partialNoteLine, sameItem, cancelReduceOn, type BgState, type PartialLine } from './cancelReducePlan.ts';
import type { BfmrLine } from './bfmrCancelPlan.ts';

const NOW = new Date('2026-11-20T12:00:00Z');
const bg = (over: Partial<BgState> = {}): BgState => ({
  quantity: 5, status: 'ACTIVE', editable: true, dealActive: true, expiry: new Date('2026-12-31T00:00:00Z'),
  dealKey: 'dk', itemKey: 'ik', source: 'live', ...over,
});
const plan = (released: number, stillLinked: number, state: BgState | null = bg()) => planBgReduce({ released, stillLinked, bg: state, now: NOW });

test('setting is off unless exactly "true"', () => {
  assert.equal(cancelReduceOn(undefined), false);
  assert.equal(cancelReduceOn('false'), false);
  assert.equal(cancelReduceOn('true'), true);
});

test('BG: quantity drops by the released units', () => {
  assert.deepEqual(plan(2, 0), { kind: 'reduce', from: 5, to: 3, dealKey: 'dk', itemKey: 'ik', source: 'live' });
});

test('BG: never below what other live orders still hold, never below 0', () => {
  assert.deepEqual(plan(2, 4), { kind: 'reduce', from: 5, to: 4, dealKey: 'dk', itemKey: 'ik', source: 'live' });
  assert.equal(plan(5, 0).kind === 'reduce' && (plan(5, 0) as { to: number }).to, 0);
  // Others already hold everything BG has: nothing to lower.
  assert.deepEqual(plan(2, 5), { kind: 'skip', reason: 'other orders still hold all of it', from: 5 });
});

test('BG: skipped with a reason when BG says no', () => {
  assert.match((plan(1, 0, bg({ status: 'COMPLETED' })) as { reason: string }).reason, /COMPLETED/);
  assert.equal((plan(1, 0, bg({ dealActive: false })) as { reason: string }).reason, 'the deal is closed on BG');
  assert.equal((plan(1, 0, bg({ expiry: new Date('2026-11-01T00:00:00Z') })) as { reason: string }).reason, 'the commitment has expired');
  assert.equal((plan(1, 0, bg({ editable: false })) as { reason: string }).reason, 'BG does not allow editing it');
  assert.equal((plan(1, 0, bg({ itemKey: null })) as { reason: string }).reason, 'no BG deal or item key on file');
  assert.equal((plan(1, 0, null) as { reason: string }).reason, 'no BG record for the commitment');
});

test('BG: fewer units on BG than were released does not line up', () => {
  assert.deepEqual(plan(6, 0), { kind: 'skip', reason: 'BG has 5, fewer than the 6 released', from: 5 });
});

test('BG: a commitment that expires today can still be edited', () => {
  assert.equal(plan(1, 0, bg({ expiry: new Date('2026-11-20T00:00:00Z') })).kind, 'reduce');
});

test('bgStateFrom reads a BG record', () => {
  const s = bgStateFrom({ status: 'ACTIVE', editable: true, deal_status: true, expiry_day: '12-31-2026', deal: { key: 'd' }, item: { key: 'i' } }, 4, 'synced');
  assert.deepEqual(s, { quantity: 4, status: 'ACTIVE', editable: true, dealActive: true, expiry: new Date('2026-12-31T00:00:00Z'), dealKey: 'd', itemKey: 'i', source: 'synced' });
  assert.equal(bgStateFrom(null, 1, 'live'), null);
  // A record with no editable flag is not editable.
  assert.equal(bgStateFrom({ status: 'ACTIVE' }, 1, 'live')!.editable, false);
});

test('notification lines', () => {
  assert.equal(bgOutcomeLine({ name: 'Kettle', state: 'reduced', from: 5, to: 3 }), 'BG: reduced Kettle 5 → 3');
  assert.equal(bgOutcomeLine({ name: 'Kettle', state: 'would', from: 5, to: 3 }), 'BG: would reduce Kettle 5 → 3 (setting off)');
  assert.match(bgOutcomeLine({ name: 'Kettle', state: 'skipped', reason: 'the deal is closed on BG' }), /left Kettle as is \(the deal is closed on BG\)/);
  assert.match(bgOutcomeLine({ name: 'Kettle', state: 'failed', reason: 'the BG call failed' }), /could not reduce/);
});

// ---- partial cancels

const line = (over: Partial<PartialLine> = {}): PartialLine => ({ group: 'BuyingGroup', linkId: 1, name: 'Acme Smart Kettle 1.7L Steel', quantity: 3, targetId: 10, ...over });

test('item text: name, optional (xN), several items', () => {
  assert.deepEqual(cancelledItem('Acme Kettle (x2)'), { name: 'Acme Kettle', quantity: 2 });
  assert.deepEqual(cancelledItem('Acme Kettle'), { name: 'Acme Kettle', quantity: null });
  assert.equal(cancelledItem('Acme Kettle (+1 more)'), null);
  assert.equal(cancelledItem(''), null);
});

test('item names match on words, not exact text', () => {
  assert.equal(sameItem('Acme Smart Kettle 1.7L', 'Acme Smart Kettle 1.7L Steel'), true);
  assert.equal(sameItem('Acme Toaster 2 Slice', 'Acme Smart Kettle 1.7L Steel'), false);
  assert.equal(sameItem('Kettle', 'Kettle Pro'), false);
});

test('partial: one matching line, quantity given', () => {
  assert.deepEqual(planPartialCancel('Acme Smart Kettle 1.7L (x2)', [line()]), { kind: 'apply', line: line(), units: 2 });
});

test('partial: no quantity means 1 unit (the parser writes (xN) only above 1), never the whole line', () => {
  assert.deepEqual(planPartialCancel('Acme Smart Kettle 1.7L', [line()]), { kind: 'apply', line: line(), units: 1 });
});

test('partial: ambiguous or oversized stays held', () => {
  const other = line({ linkId: 2, name: 'Acme Toaster 2 Slice' });
  assert.equal(planPartialCancel('Acme Smart Kettle 1.7L', [line(), other]).kind, 'apply');
  assert.equal(planPartialCancel('Acme Smart Kettle 1.7L', [line(), line({ linkId: 3, group: 'BFMR', targetId: 4 })]).kind, 'hold');
  assert.equal(planPartialCancel('Something Else Entirely', [line()]).kind, 'hold');
  assert.equal(planPartialCancel('Acme Smart Kettle 1.7L (x4)', [line()]).kind, 'hold');
  assert.equal(planPartialCancel('Acme Smart Kettle 1.7L (+2 more)', [line()]).kind, 'hold');
  assert.equal(planPartialCancel(undefined, [line()]).kind, 'hold');
  assert.equal(planPartialCancel('Acme Smart Kettle 1.7L', []).kind, 'hold');
});

const ORDER = { id: 7, orderNumber: '111-2223334-4445556' };
const bfmrLine = (over: Partial<BfmrLine> = {}): BfmrLine => ({
  reserveId: 'R1', status: 'purchased', qty: 2, retailPrice: 100, bfmrOrderId: '111-2223334-4445556', links: [{ orderId: 7, quantity: 2 }], ...over,
});

test('partial BFMR: a whole reserve id of this order passes the usual checks', () => {
  assert.deepEqual(planBfmrPartial(ORDER, 'R1', 2, 205, [bfmrLine()]), { cancel: ['R1'], left: [] });
});

test('partial BFMR: part of a reservation, shared, or off-price stays open with a reason', () => {
  assert.match(planBfmrPartial(ORDER, 'R1', 1, 100, [bfmrLine()]).left[0], /1 of 2 reserved units/);
  assert.deepEqual(planBfmrPartial(ORDER, 'R1', 2, 205, [bfmrLine({ links: [{ orderId: 7, quantity: 1 }, { orderId: 8, quantity: 1 }] })]).left, ['part of it is linked to another order']);
  assert.match(planBfmrPartial(ORDER, 'R1', 2, 20, [bfmrLine()]).left[0], /price doesn't match/);
  assert.deepEqual(planBfmrPartial(ORDER, 'R1', 2, 0, [bfmrLine()]).left, ['no price to compare']);
  assert.deepEqual(planBfmrPartial(ORDER, null, 2, 205, [bfmrLine()]).left, ['no BFMR reservation id on file']);
  assert.deepEqual(planBfmrPartial(ORDER, 'R1', 2, 205, [bfmrLine({ status: 'shipped' })]).left, ['it is shipped on BFMR']);
});

test('partial note line is dated and says the cost is unchanged', () => {
  assert.equal(partialNoteLine('2026-11-19', 2, 'Acme Kettle', 59.5), 'Partial cancel 2026-11-19: 2× Acme Kettle, $59.50 cancelled. Order cost not changed: fix it');
  assert.equal(partialNoteLine('2026-11-19', 1, 'Acme Kettle', 0), 'Partial cancel 2026-11-19: 1× Acme Kettle. Order cost not changed: fix it');
});
