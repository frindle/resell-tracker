/**
 *   node --experimental-strip-types --test lib/bfmrVanished.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { vanishedOrderIds, itemsForOrder, supersededRowIds } from './bfmrVanished.ts';

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

// supersededRowIds: a BFMR-replaced reservation (order 943: LMkey -> R4Reuic)
// supersedes the old local rows; split siblings and finished rows never do.
test('basic superseded row: not finished, lineKey absent, replacement exists', () => {
  const local = [
    { id: 1, lineKey: '5102424|p1|s1', reserveId: '5102424|p1|s1', itemId: 4417, status: 'shipped' },
  ];
  const lookupItems = [
    { reserve_id: 'R4Reuic', purchase_id: 'p2', shipment_id: 's2', item_id: 4417 },
  ];
  const result = supersededRowIds(local, lookupItems);
  assert.deepEqual(result, [1]);
});

test('split sibling + replacement on the SAME item_id: split sibling wins, NOT superseded', () => {
  // The lookup has a line sharing the row's reserve_id head (5102424) AND
  // a line with a different reserve_id (R4Reuic) for the same item_id (4417).
  // The split sibling guard excludes the row.
  const local = [
    { id: 1, lineKey: '5102424|p1|s1', reserveId: '5102424|p1|s1', itemId: 4417, status: 'shipped' },
  ];
  const lookupItems = [
    { reserve_id: '5102424', purchase_id: 'p1', shipment_id: 's1', item_id: 4417 },  // split sibling (same head)
    { reserve_id: 'R4Reuic', purchase_id: 'p2', shipment_id: 's2', item_id: 4417 },   // replacement (different head)
  ];
  const result = supersededRowIds(local, lookupItems);
  assert.deepEqual(result, []);
});

test('null, undefined, number, string, array entries in lookupItems are skipped', () => {
  const local = [
    { id: 1, lineKey: '5102424|p1|s1', reserveId: '5102424|p1|s1', itemId: 4417, status: 'shipped' },
  ];
  const lookupItems = [
    null,
    undefined,
    42,
    'string',
    [1, 2],
    { reserve_id: 'R4Reuic', purchase_id: 'p2', shipment_id: 's2', item_id: 4417 },  // valid entry
  ];
  const result = supersededRowIds(local, lookupItems);
  assert.deepEqual(result, [1]);
});

test('item_id as number vs string matches (4417 vs "4417")', () => {
  const local = [
    { id: 1, lineKey: '5102424|p1|s1', reserveId: '5102424|p1|s1', itemId: 4417, status: 'shipped' },
  ];
  const lookupItems = [
    { reserve_id: 'R4Reuic', purchase_id: 'p2', shipment_id: 's2', item_id: '4417' },  // string
  ];
  const result = supersededRowIds(local, lookupItems);
  assert.deepEqual(result, [1]);
});

test('empty lookupItems returns []', () => {
  const local = [
    { id: 1, lineKey: '5102424|p1|s1', reserveId: '5102424|p1|s1', itemId: 4417, status: 'shipped' },
  ];
  const result = supersededRowIds(local, []);
  assert.deepEqual(result, []);
});

test('non-array lookupItems returns []', () => {
  const local = [
    { id: 1, lineKey: '5102424|p1|s1', reserveId: '5102424|p1|s1', itemId: 4417, status: 'shipped' },
  ];
  const result = supersededRowIds(local, 'not an array' as unknown as unknown[]);
  assert.deepEqual(result, []);
});

test('finished status rows are NOT superseded (case-insensitive)', () => {
  const local = [
    { id: 1, lineKey: '5102424|p1|s1', reserveId: '5102424|p1|s1', itemId: 4417, status: 'paid' },
    { id: 2, lineKey: '5102424|p1|s1', reserveId: '5102424|p1|s1', itemId: 4417, status: 'PAID' },
    { id: 3, lineKey: '5102424|p1|s1', reserveId: '5102424|p1|s1', itemId: 4417, status: 'cancelled' },
    { id: 4, lineKey: '5102424|p1|s1', reserveId: '5102424|p1|s1', itemId: 4417, status: 'returned' },
    { id: 5, lineKey: '5102424|p1|s1', reserveId: '5102424|p1|s1', itemId: 4417, status: 'return' },
    { id: 6, lineKey: '5102424|p1|s1', reserveId: '5102424|p1|s1', itemId: 4417, status: 'set_aside' },
    { id: 7, lineKey: '5102424|p1|s1', reserveId: '5102424|p1|s1', itemId: 4417, status: 'closed' },
  ];
  const lookupItems = [
    { reserve_id: 'R4Reuic', purchase_id: 'p2', shipment_id: 's2', item_id: 4417 },
  ];
  const result = supersededRowIds(local, lookupItems);
  assert.deepEqual(result, []);
});

test('motivating case: order 943', () => {
  // BFMR replaced reservation LMkey (my_tracker_id 5102424) with R4Reuic (5123566);
  // the old local rows 351583 and 328542 must be returned.
  const local = [
    { id: 351583, lineKey: '5102424|p1|s1', reserveId: '5102424|p1|s1', itemId: 4417, status: 'shipped' },
    { id: 328542, lineKey: '5102424|p1|s1', reserveId: '5102424|p1|s1', itemId: 4417, status: 'shipped' },
  ];
  const lookupItems = [
    { reserve_id: 'R4Reuic', purchase_id: 'p2', shipment_id: 's2', item_id: 4417 },
  ];
  const result = supersededRowIds(local, lookupItems);
  assert.deepEqual(result, [351583, 328542]);
});

test('row lineKey present in lookup: NOT superseded', () => {
  const local = [
    { id: 1, lineKey: '5102424|p1|s1', reserveId: '5102424|p1|s1', itemId: 4417, status: 'shipped' },
  ];
  const lookupItems = [
    { reserve_id: '5102424', purchase_id: 'p1', shipment_id: 's1', item_id: 4417 },  // same lineKey
  ];
  const result = supersededRowIds(local, lookupItems);
  assert.deepEqual(result, []);
});
