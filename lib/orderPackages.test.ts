import test from 'node:test';
import assert from 'node:assert/strict';
import { mergePackage, toDryRunEntry, decisionSignature } from './orderPackages.ts';
import { matchPackages } from './bfmrPackageMatch.ts';

const known = { trackingNumber: 'TBA000000000001', carrier: null, itemsKnown: true, items: [{ title: 'Widget Alpha', quantity: 2 }] };

test('merge: readable items replace stored ones', () => {
  const m = mergePackage(known, { trackingNumber: 'TBA000000000001', items: [{ title: 'Widget Alpha', quantity: 3 }], source: 'detail' });
  assert.equal(m.items[0].quantity, 3);
  assert.equal(m.itemsKnown, true);
});

test('merge: an unreadable capture never wipes items already read', () => {
  const m = mergePackage(known, { trackingNumber: 'TBA000000000001', items: null, source: 'tracking', carrier: 'Amazon Logistics' });
  assert.equal(m.itemsKnown, true);
  assert.equal(m.items[0].quantity, 2);
  assert.equal(m.carrier, 'Amazon Logistics');
});

test('merge: first sight with unreadable items is stored as unknown, not empty-known', () => {
  const m = mergePackage(null, { trackingNumber: 'TBA000000000001', items: null, source: 'detail' });
  assert.equal(m.itemsKnown, false);
  assert.deepEqual(m.items, []);
});

test('dry-run entry: exact lists what would be sent; manual lists nothing', () => {
  const lines = [{ id: 10, reserveId: 'R', bfmrOrderId: '111-0000000-0000001', itemName: 'Widget Alpha Pro', dealTitle: null, qty: 1, status: 'purchased', trackingNumber: null, submitted: [], links: [{ orderId: 1, quantity: 1, trackingNumber: null }] }];
  const pkgs = [
    { orderId: 1, orderNumber: '111-0000000-0000001', trackingNumber: 'TBA000000000001', itemsKnown: true, items: [{ title: 'Widget Alpha Pro Max', quantity: 1 }] },
    { orderId: 1, orderNumber: '111-0000000-0000001', trackingNumber: 'TBA000000000002', itemsKnown: false, items: [] },
  ];
  const [a, b] = matchPackages(pkgs, lines).map(toDryRunEntry);
  assert.deepEqual(a.wouldSubmit, [{ reservationId: 10, qty: 1, trackingNumber: 'TBA000000000001' }]);
  assert.equal(b.decision, 'manual');
  assert.equal(b.reason, 'items_unknown');
  assert.deepEqual(b.wouldSubmit, []);
});

test('signature: same decision same signature, different quantity different signature', () => {
  const mk = (qty: number) => decisionSignature({ decision: 'exact', orderId: 1, orderNumber: null, trackingNumber: ' tba000000000001', allocations: [{ reservationId: 1, qty }], message: '', caveats: [] });
  assert.equal(mk(1), mk(1));
  assert.notEqual(mk(1), mk(2));
});
