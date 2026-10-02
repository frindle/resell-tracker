/**
 *   node --experimental-strip-types --test lib/bfmrVanished.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { vanishedOrderIds, itemsForOrder } from './bfmrVanished.ts';

test('only open local rows missing from the pull are looked up, deduped, capped', () => {
  const local = [
    { lineKey: 'a', bfmrOrderId: '111', status: 'shipped' },
    { lineKey: 'b', bfmrOrderId: '111', status: 'shipped' },
    { lineKey: 'c', bfmrOrderId: '222', status: 'paid' },
    { lineKey: 'd', bfmrOrderId: '333', status: 'processed' },
    { lineKey: 'e', bfmrOrderId: null, status: 'shipped' },
  ];
  assert.deepEqual(vanishedOrderIds(local, new Set(['d'])), ['111']);
  assert.deepEqual(vanishedOrderIds(local, new Set()), ['111', '333']);
  assert.deepEqual(vanishedOrderIds(local, new Set(), 1), ['111']);
});

test('search hits for other orders are dropped', () => {
  const items = [{ order_id: '111', x: 1 }, { order_id: '999', x: 2 }];
  assert.deepEqual(itemsForOrder(items, '111'), [{ order_id: '111', x: 1 }]);
});
