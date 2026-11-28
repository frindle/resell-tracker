import test from 'node:test';
import assert from 'node:assert/strict';
import { pickByOrderNumber } from './orderPick.ts';

const row = (id: number, cancelled: boolean, orderNumber: string | null = '111-2223334-4445556') => ({ id, orderNumber, cancelled });

test('a live order beats a cancelled one whichever row comes last', () => {
  assert.equal(pickByOrderNumber([row(1, false), row(2, true)]).get('11122233344445556')!.id, 1);
  assert.equal(pickByOrderNumber([row(2, true), row(1, false)]).get('11122233344445556')!.id, 1);
});

test('between two live orders the newest wins, and between two cancelled ones too', () => {
  assert.equal(pickByOrderNumber([row(5, false), row(9, false), row(7, false)]).get('11122233344445556')!.id, 9);
  assert.equal(pickByOrderNumber([row(9, true), row(5, true)]).get('11122233344445556')!.id, 9);
});

test('numbers match without punctuation; orders with no number are left out', () => {
  const m = pickByOrderNumber([row(1, false, '111 2223334 4445556'), row(2, false, null), row(3, false, 'n/a')]);
  assert.deepEqual([...m.keys()], ['11122233344445556']);
});
