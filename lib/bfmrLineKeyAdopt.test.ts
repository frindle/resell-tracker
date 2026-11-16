// npm run test:bfmr-line-key-adopt
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planLineKeyAdoptions, staleReservedRowIds } from './bfmrLineKeyAdopt.ts';

const old = { id: 1, lineKey: 'R|P|', reserveId: 'R', purchaseId: 'P', shipmentId: null };

test('adopts the null-shipment row when BFMR assigns a shipment_id', () => {
  const r = planLineKeyAdoptions([{ reserve_id: 'R', purchase_id: 'P', shipment_id: 'S' }], [old]);
  assert.deepEqual(r, [{ id: 1, fromLineKey: 'R|P|', toLineKey: 'R|P|S' }]);
});

test('no adoption when the new key already exists, or ids differ, or no shipment', () => {
  const item = { reserve_id: 'R', purchase_id: 'P', shipment_id: 'S' };
  assert.equal(planLineKeyAdoptions([item], [old, { ...old, id: 2, lineKey: 'R|P|S', shipmentId: 'S' }]).length, 0);
  assert.equal(planLineKeyAdoptions([{ ...item, purchase_id: 'Q' }], [old]).length, 0);
  assert.equal(planLineKeyAdoptions([{ ...item, reserve_id: 'r' }], [old]).length, 0);
  assert.equal(planLineKeyAdoptions([{ reserve_id: 'R', purchase_id: 'P' }], [old]).length, 0);
});

test('one old row is adopted by at most one new key', () => {
  const r = planLineKeyAdoptions(
    [
      { reserve_id: 'R', purchase_id: 'P', shipment_id: 'S1' },
      { reserve_id: 'R', purchase_id: 'P', shipment_id: 'S2' },
    ],
    [old],
  );
  assert.equal(r.length, 1);
  assert.equal(r[0].toLineKey, 'R|P|S1');
});

test('collision: old null-shipment row + row already holding toLineKey -> no adoption', () => {
  const taken = { id: 2, lineKey: 'R|P|S', reserveId: 'R', purchaseId: 'P', shipmentId: 'S' };
  assert.deepEqual(planLineKeyAdoptions([{ reserve_id: 'R', purchase_id: 'P', shipment_id: 'S' }], [old, taken]), []);
});

test('two items mapping to one old row -> adopted once', () => {
  const r = planLineKeyAdoptions(
    [
      { reserve_id: 'R', purchase_id: 'P', shipment_id: 'S1' },
      { reserve_id: 'R', purchase_id: 'P', shipment_id: 'S2' },
    ],
    [old],
  );
  assert.equal(r.length, 1);
});

// Purchase assigned after the reservation was first stored ("R||" -> "R|P|").
const reserved = { id: 5, lineKey: 'R||', reserveId: 'R', purchaseId: null, shipmentId: null };

test('adopts the unpurchased row when BFMR assigns a purchase_id (full sync)', () => {
  const r = planLineKeyAdoptions([{ reserve_id: 'R', purchase_id: 'P' }], [reserved], { adoptUnpurchased: true });
  assert.deepEqual(r, [{ id: 5, fromLineKey: 'R||', toLineKey: 'R|P|' }]);
  const shipped = planLineKeyAdoptions([{ reserve_id: 'R', purchase_id: 'P', shipment_id: 'S' }], [reserved], { adoptUnpurchased: true });
  assert.deepEqual(shipped, [{ id: 5, fromLineKey: 'R||', toLineKey: 'R|P|S' }]);
});

test('purchase adoption is off for a partial sync', () => {
  assert.deepEqual(planLineKeyAdoptions([{ reserve_id: 'R', purchase_id: 'P' }], [reserved]), []);
});

test('a split remainder BFMR still returns is never adopted', () => {
  const items = [{ reserve_id: 'R', purchase_id: 'P' }, { reserve_id: 'R' }];
  assert.deepEqual(planLineKeyAdoptions(items, [reserved], { adoptUnpurchased: true }), []);
});

test('an exact purchase match wins over the unpurchased row', () => {
  const r = planLineKeyAdoptions(
    [{ reserve_id: 'R', purchase_id: 'P', shipment_id: 'S' }, { reserve_id: 'R', purchase_id: 'Q' }],
    [old, reserved],
    { adoptUnpurchased: true },
  );
  assert.deepEqual(r, [
    { id: 1, fromLineKey: 'R|P|', toLineKey: 'R|P|S' },
    { id: 5, fromLineKey: 'R||', toLineKey: 'R|Q|' },
  ]);
});

test('no purchase adoption when the purchased key already exists', () => {
  const taken = { id: 6, lineKey: 'R|P|', reserveId: 'R', purchaseId: 'P', shipmentId: null };
  assert.deepEqual(planLineKeyAdoptions([{ reserve_id: 'R', purchase_id: 'P' }], [reserved, taken], { adoptUnpurchased: true }), []);
});

test('stale reserved twin: removed only when unlinked, unreturned and a sibling is purchased', () => {
  const twin = { ...reserved, status: 'reserved', links: 0 };
  const bought = { id: 6, lineKey: 'R|P|', reserveId: 'R', purchaseId: 'P', shipmentId: null, status: 'purchased', links: 1 };
  const keys = new Set(['R|P|']);
  assert.deepEqual(staleReservedRowIds([twin, bought], keys), [5]);
  assert.deepEqual(staleReservedRowIds([{ ...twin, links: 1 }, bought], keys), []);
  assert.deepEqual(staleReservedRowIds([twin, bought], new Set(['R|P|', 'R||'])), []);
  assert.deepEqual(staleReservedRowIds([twin], keys), []);
  assert.deepEqual(staleReservedRowIds([{ ...twin, status: 'cancelled' }, bought], keys), []);
});
