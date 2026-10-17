// npm run test:bfmr-line-key-adopt
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planLineKeyAdoptions } from './bfmrLineKeyAdopt.ts';

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
