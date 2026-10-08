import test from 'node:test';
import assert from 'node:assert/strict';
import { dropOffOrderTracking } from './offOrderTracking.ts';

const t = (l: { trk: string | null }) => l.trk;

test('order 943: line on a tracking the order never had is dropped', () => {
  const lines = [{ trk: '9339589725268887906837', v: 297 }, { trk: '9339589725268808146397', v: 297 }];
  assert.deepEqual(dropOffOrderTracking(lines, '9339589725268887906837', t).map(l => l.v), [297]);
});
test('split shipment with both trackings on the order keeps both', () => {
  const lines = [{ trk: 'A1' }, { trk: 'B2' }];
  assert.equal(dropOffOrderTracking(lines, 'A1, B2', t).length, 2);
});
test('shared tracking (order 929) keeps both', () => {
  assert.equal(dropOffOrderTracking([{ trk: 'A1' }, { trk: 'a1' }], 'A1', t).length, 2);
});
test('never empties: no line matches, or order has no tracking', () => {
  const lines = [{ trk: 'X' }, { trk: 'Y' }];
  assert.equal(dropOffOrderTracking(lines, 'Z', t).length, 2);
  assert.equal(dropOffOrderTracking(lines, null, t).length, 2);
  assert.equal(dropOffOrderTracking(lines, '', t).length, 2);
});
test('untracked lines are kept', () => {
  assert.equal(dropOffOrderTracking([{ trk: 'A1' }, { trk: null }, { trk: 'X' }], 'A1', t).length, 2);
});
