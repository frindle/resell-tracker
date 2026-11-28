import test from 'node:test';
import assert from 'node:assert/strict';
import { sweepCandidateIds, type SweepOrder, type SweepBackoff } from './autoSubmitSweepPlan.ts';

const NOW = Date.parse('2030-01-20T12:00:00Z');
const base: SweepOrder = {
  id: 1, orderDate: new Date('2030-01-18T00:00:00Z'), trackingNumbers: '1ZFAKE0000000001',
  trackingSubmittedToBg: false, cancelled: false, locked: false, buyerName: 'BigSkyBuyers',
};
const ids = (o: Partial<SweepOrder>) => sweepCandidateIds([{ ...base, ...o }], NOW);

test('BigSky order with tracking and no submit is a candidate', () => {
  assert.deepEqual(ids({}), [1]);
});
test('BuyingGroup order is a candidate too', () => {
  assert.deepEqual(ids({ buyerName: 'BuyingGroup' }), [1]);
});
test('no tracking, blank tracking, or already submitted is skipped', () => {
  assert.deepEqual(ids({ trackingNumbers: null }), []);
  assert.deepEqual(ids({ trackingNumbers: ' , ' }), []);
  assert.deepEqual(ids({ trackingSubmittedToBg: true }), []);
});
test('cancelled, locked, other buyers and no buyer are skipped', () => {
  assert.deepEqual(ids({ cancelled: true }), []);
  assert.deepEqual(ids({ locked: true }), []);
  assert.deepEqual(ids({ buyerName: 'BFMR' }), []);
  assert.deepEqual(ids({ buyerName: null }), []);
});
test('orders older than the window are skipped', () => {
  assert.deepEqual(ids({ orderDate: new Date('2029-10-01T00:00:00Z') }), []);
});
test('an order still unsubmitted after a sweep backs off, doubling to a day', () => {
  const backoff: SweepBackoff = new Map();
  const MIN = 60_000;
  assert.deepEqual(sweepCandidateIds([base], NOW, backoff), [1]);
  assert.deepEqual(sweepCandidateIds([base], NOW + 10 * MIN, backoff), []);
  assert.deepEqual(sweepCandidateIds([base], NOW + 15 * MIN, backoff), [1]);
  assert.deepEqual(sweepCandidateIds([base], NOW + 40 * MIN, backoff), []);
  assert.deepEqual(sweepCandidateIds([base], NOW + 45 * MIN, backoff), [1]);
  backoff.set(1, { tries: 20, nextMs: 0 });
  assert.deepEqual(sweepCandidateIds([base], NOW, backoff), [1]);
  assert.equal(backoff.get(1)!.nextMs - NOW, 24 * 60 * MIN);
});
test('a submitted order leaves the backoff', () => {
  const backoff: SweepBackoff = new Map([[1, { tries: 3, nextMs: NOW + 1e9 }]]);
  assert.deepEqual(sweepCandidateIds([{ ...base, trackingSubmittedToBg: true }], NOW, backoff), []);
  assert.equal(backoff.has(1), false);
});
