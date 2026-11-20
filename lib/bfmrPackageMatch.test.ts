/**
 * Tests for the package -> BFMR reservation matcher. All data is made up.
 *   npm run test:bfmr-package-match
 *
 * The cases that matter are the wrong-quantity ones: every "exact" must be a
 * case where units line up to the unit, and every near-miss must be manual.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  matchPackages, itemNamesAgree, type PackageIn, type ReservationLineIn, type PackageDecision,
} from './bfmrPackageMatch.ts';

const ORDER_A = '111-0000000-0000001';
const ORDER_B = '111-0000000-0000002';

function pkg(over: Partial<PackageIn> & { items?: PackageIn['items'] } = {}): PackageIn {
  return {
    orderId: 1, orderNumber: ORDER_A, trackingNumber: 'TBA000000000001', itemsKnown: true,
    items: [{ title: 'Acme Widget Pro 256GB Graphite Edition', quantity: 1 }],
    ...over,
  };
}
function res(id: number, over: Partial<ReservationLineIn> = {}): ReservationLineIn {
  return {
    id, reserveId: `R${id}`, bfmrOrderId: ORDER_A, itemName: 'Acme Widget Pro 256GB', dealTitle: null, qty: 1, status: 'purchased',
    trackingNumber: null, submitted: [], links: [{ orderId: 1, quantity: 1, trackingNumber: null }],
    ...over,
  };
}
const one = (p: PackageIn[], r: ReservationLineIn[]) => matchPackages(p, r);
const manual = (d: PackageDecision) => { assert.equal(d.decision, 'manual'); return d as Extract<PackageDecision, { decision: 'manual' }>; };

test('item name agreement needs distinctive overlap, not one shared word', () => {
  assert.equal(itemNamesAgree('Acme Widget Pro 256GB Graphite Edition', 'Acme Widget Pro 256GB'), true);
  assert.equal(itemNamesAgree('Acme Widget Mini Case', 'Acme Widget Pro 256GB'), false);
  assert.equal(itemNamesAgree('anything', null), false);
  // same product line, different size: the digit-bearing word must match
  assert.equal(itemNamesAgree('Acme Widget Pro 512GB Graphite Edition', 'Acme Widget Pro 256GB'), false);
  assert.equal(itemNamesAgree('Zorbotron', 'Zorbotron'), true);
});

test('single package, single reservation, same quantity -> exact', () => {
  const [d] = one([pkg()], [res(10)]);
  assert.equal(d.decision, 'exact');
  assert.deepEqual(d.allocations, [{ reservationId: 10, qty: 1 }]);
});

test('single package of 2 against a qty-2 reservation -> exact with qty 2', () => {
  const [d] = one([pkg({ items: [{ title: 'Acme Widget Pro 256GB', quantity: 2 }] })], [res(10, { qty: 2, links: [{ orderId: 1, quantity: 2, trackingNumber: null }] })]);
  assert.equal(d.decision, 'exact');
  assert.deepEqual(d.allocations, [{ reservationId: 10, qty: 2 }]);
});

test('quantity over: package has more than the reservation -> manual quantity_over', () => {
  const [d] = one([pkg({ items: [{ title: 'Acme Widget Pro 256GB', quantity: 3 }] })], [res(10, { qty: 2, links: [{ orderId: 1, quantity: 2, trackingNumber: null }] })]);
  assert.equal(manual(d).reason, 'quantity_over');
});

test('quantity under: package has fewer than the reservation -> manual quantity_under', () => {
  const [d] = one([pkg()], [res(10, { qty: 2, links: [{ orderId: 1, quantity: 2, trackingNumber: null }] })]);
  assert.equal(manual(d).reason, 'quantity_under');
});

test('order split across 3 packages that add up to the reservation -> all three exact, one unit each', () => {
  const pk = [1, 2, 3].map(n => pkg({ trackingNumber: `TBA00000000010${n}` }));
  const ds = one(pk, [res(10, { qty: 3, links: [{ orderId: 1, quantity: 3, trackingNumber: null }] })]);
  assert.deepEqual(ds.map(d => d.decision), ['exact', 'exact', 'exact']);
  assert.ok(ds.every(d => d.allocations.length === 1 && d.allocations[0].qty === 1));
});

test('order split into 2 packages but only 2 of 3 units seen -> both manual (do not submit a partial)', () => {
  const pk = [1, 2].map(n => pkg({ trackingNumber: `TBA00000000010${n}` }));
  const ds = one(pk, [res(10, { qty: 3, links: [{ orderId: 1, quantity: 3, trackingNumber: null }] })]);
  assert.deepEqual(ds.map(d => manual(d).reason), ['quantity_under', 'quantity_under']);
});

test('split order where a sibling package is unreadable: the readable ones still need the full count', () => {
  const pk = [pkg({ trackingNumber: 'TBA000000000101' }), pkg({ trackingNumber: 'TBA000000000102', itemsKnown: false, items: [] })];
  const ds = one(pk, [res(10, { qty: 2, links: [{ orderId: 1, quantity: 2, trackingNumber: null }] })]);
  assert.equal(manual(ds[0]).reason, 'quantity_under');
  assert.match(ds[0].message, /could not be read/);
  assert.equal(manual(ds[1]).reason, 'items_unknown');
});

test('known units already fill the reservation, an unreadable sibling cannot add more -> still exact', () => {
  const pk = [pkg({ trackingNumber: 'TBA000000000101', items: [{ title: 'Acme Widget Pro 256GB', quantity: 2 }] }), pkg({ trackingNumber: 'TBA000000000102', itemsKnown: false, items: [] })];
  const ds = one(pk, [res(10, { qty: 2, links: [{ orderId: 1, quantity: 2, trackingNumber: null }] })]);
  assert.equal(ds[0].decision, 'exact');
  assert.equal(manual(ds[1]).reason, 'items_unknown');
});

test('combined orders in one box: same tracking under two orders -> both manual', () => {
  const pk = [pkg(), pkg({ orderId: 2, orderNumber: ORDER_B })];
  const ds = one(pk, [res(10), res(11, { bfmrOrderId: ORDER_B, links: [{ orderId: 2, quantity: 1, trackingNumber: null }] })]);
  assert.deepEqual(ds.map(d => manual(d).reason), ['combined_order', 'combined_order']);
});

test('units in a combined box are not counted for either order', () => {
  const pk = [pkg({ trackingNumber: 'TBA000000000009' }), pkg({ orderId: 2, orderNumber: ORDER_B, trackingNumber: 'TBA000000000009' }), pkg({ trackingNumber: 'TBA000000000002' })];
  const ds = one(pk, [res(10, { qty: 2, links: [{ orderId: 1, quantity: 2, trackingNumber: null }] })]);
  assert.equal(manual(ds[0]).reason, 'combined_order');
  // units in the combined box are not counted for order 1, so the lone readable package is 1 of 2
  assert.equal(manual(ds[2]).reason, 'quantity_under');
});

test('BFMR-side split (two lines, one reserveId) with one package covering both -> exact over two lines', () => {
  const lines = [
    res(10, { reserveId: 'RS1', qty: 1, links: [{ orderId: 1, quantity: 1, trackingNumber: null }] }),
    res(11, { reserveId: 'RS1', qty: 2, links: [{ orderId: 1, quantity: 2, trackingNumber: null }] }),
  ];
  const [d] = one([pkg({ items: [{ title: 'Acme Widget Pro 256GB', quantity: 3 }] })], lines);
  assert.equal(d.decision, 'exact');
  assert.deepEqual([...d.allocations].sort((a, b) => a.reservationId - b.reservationId), [{ reservationId: 10, qty: 1 }, { reservationId: 11, qty: 2 }]);
});

test('BFMR-side split with distinct package sizes -> unique assignment, exact', () => {
  const lines = [
    res(10, { reserveId: 'RS1', qty: 1, links: [{ orderId: 1, quantity: 1, trackingNumber: null }] }),
    res(11, { reserveId: 'RS1', qty: 2, links: [{ orderId: 1, quantity: 2, trackingNumber: null }] }),
  ];
  const pk = [pkg({ trackingNumber: 'TBA000000000101', items: [{ title: 'Acme Widget Pro 256GB', quantity: 2 }] }), pkg({ trackingNumber: 'TBA000000000102' })];
  const ds = one(pk, lines);
  assert.equal(ds[0].decision, 'exact');
  assert.deepEqual(ds[0].allocations, [{ reservationId: 11, qty: 2 }]);
  assert.deepEqual(ds[1].allocations, [{ reservationId: 10, qty: 1 }]);
});

test('BFMR-side split with identical lines and identical packages -> ambiguous, manual', () => {
  const lines = [res(10, { reserveId: 'RS1' }), res(11, { reserveId: 'RS1' })];
  const pk = [pkg({ trackingNumber: 'TBA000000000101' }), pkg({ trackingNumber: 'TBA000000000102' })];
  const ds = one(pk, lines);
  assert.deepEqual(ds.map(d => manual(d).reason), ['ambiguous_lines', 'ambiguous_lines']);
});

test('BFMR-side split where the package would have to cut a line in half -> manual', () => {
  const lines = [res(10, { reserveId: 'RS1', qty: 2, links: [{ orderId: 1, quantity: 2, trackingNumber: null }] }), res(11, { reserveId: 'RS1', qty: 2, links: [{ orderId: 1, quantity: 2, trackingNumber: null }] })];
  const pk = [pkg({ trackingNumber: 'TBA000000000101', items: [{ title: 'Acme Widget Pro 256GB', quantity: 3 }] }), pkg({ trackingNumber: 'TBA000000000102' })];
  const ds = one(pk, lines);
  assert.deepEqual(ds.map(d => manual(d).reason), ['ambiguous_lines', 'ambiguous_lines']);
});

test('unknown items -> manual items_unknown, never guessed from the lone reservation', () => {
  const [d] = one([pkg({ itemsKnown: false, items: [] })], [res(10)]);
  assert.equal(manual(d).reason, 'items_unknown');
});

test('empty item list is unknown, not zero units', () => {
  const [d] = one([pkg({ items: [] })], [res(10)]);
  assert.equal(manual(d).reason, 'items_unknown');
});

test('bad quantities (0, fraction) -> manual bad_quantity', () => {
  assert.equal(manual(one([pkg({ items: [{ title: 'Acme Widget Pro 256GB', quantity: 0 }] })], [res(10)])[0]).reason, 'bad_quantity');
  assert.equal(manual(one([pkg({ items: [{ title: 'Acme Widget Pro 256GB', quantity: 1.5 }] })], [res(10)])[0]).reason, 'bad_quantity');
});

test('duplicate tracking rows on one order -> both manual, even when identical', () => {
  const ds = one([pkg(), pkg()], [res(10)]);
  assert.deepEqual(ds.map(d => manual(d).reason), ['duplicate_package', 'duplicate_package']);
  const diff = one([pkg(), pkg({ items: [{ title: 'Acme Widget Pro 256GB', quantity: 2 }] })], [res(10)]);
  assert.deepEqual(diff.map(d => manual(d).reason), ['duplicate_package', 'duplicate_package']);
});

test('tracking comparison ignores case and spaces', () => {
  const ds = one([pkg({ trackingNumber: 'tba 000000000001' }), pkg({ trackingNumber: 'TBA000000000001' })], [res(10)]);
  assert.deepEqual(ds.map(d => manual(d).reason), ['duplicate_package', 'duplicate_package']);
});

test('already submitted: local shipment record for this tracking -> manual', () => {
  const [d] = one([pkg()], [res(10, { qty: 2, submitted: [{ qty: 1, trackingNumber: 'TBA000000000001' }], links: [{ orderId: 1, quantity: 2, trackingNumber: null }] })]);
  assert.equal(manual(d).reason, 'already_submitted');
});

test('already submitted: BFMR already shows this tracking on the line -> manual', () => {
  const [d] = one([pkg()], [res(10, { trackingNumber: 'tba000000000001' })]);
  assert.equal(manual(d).reason, 'already_submitted');
});

test('earlier units submitted under another tracking: only the rest is matchable', () => {
  const r = res(10, { qty: 3, submitted: [{ qty: 2, trackingNumber: 'TBA000000000777' }], links: [{ orderId: 1, quantity: 3, trackingNumber: null }] });
  assert.equal(one([pkg()], [r])[0].decision, 'exact');
  assert.equal(manual(one([pkg({ items: [{ title: 'Acme Widget Pro 256GB', quantity: 2 }] })], [r])[0]).reason, 'quantity_over');
});

test('fully submitted reservation with a new package -> manual, nothing left', () => {
  const [d] = one([pkg()], [res(10, { submitted: [{ qty: 1, trackingNumber: 'TBA000000000777' }] })]);
  assert.equal(manual(d).reason, 'already_submitted');
});

test('reservation past shipped (received/paid/cancelled) is not a target', () => {
  for (const status of ['received', 'paid', 'cancelled', 'returned']) {
    assert.equal(manual(one([pkg()], [res(10, { status })])[0]).reason, 'reservation_not_eligible', status);
  }
});

test('two different reservations fit the same item -> several_candidates', () => {
  const [d] = one([pkg()], [res(10), res(11, { reserveId: 'R11' })]);
  assert.equal(manual(d).reason, 'several_candidates');
});

test('item matches no reservation -> item_unmatched (mixed order stays manual)', () => {
  const [d] = one([pkg({ items: [{ title: 'Totally Different Gadget', quantity: 1 }] })], [res(10)]);
  assert.equal(manual(d).reason, 'item_unmatched');
});

test('package with two different BFMR items, both exact -> exact across two reservations', () => {
  const lines = [res(10), res(11, { itemName: 'Globex Gizmo Ultra 512GB' })];
  const [d] = one([pkg({ items: [{ title: 'Acme Widget Pro 256GB', quantity: 1 }, { title: 'Globex Gizmo Ultra 512GB Blue', quantity: 1 }] })], lines);
  assert.equal(d.decision, 'exact');
  assert.equal(d.allocations.length, 2);
});

test('package with two items where one is off by quantity -> whole package manual', () => {
  const lines = [res(10), res(11, { itemName: 'Globex Gizmo Ultra 512GB' })];
  const [d] = one([pkg({ items: [{ title: 'Acme Widget Pro 256GB', quantity: 1 }, { title: 'Globex Gizmo Ultra 512GB Blue', quantity: 2 }] })], lines);
  assert.equal(manual(d).reason, 'quantity_over');
});

test('no reservation linked to the order -> no_candidate_reservation', () => {
  const [d] = one([pkg()], [res(10, { bfmrOrderId: null, links: [] })]);
  assert.equal(manual(d).reason, 'no_candidate_reservation');
});

test('reservation named for a different Amazon order is not a candidate even if linked', () => {
  const [d] = one([pkg()], [res(10, { bfmrOrderId: '111-9999999-9999999' })]);
  assert.equal(manual(d).reason, 'no_candidate_reservation');
});

test('reservation with unknown bfmrOrderId but a link to the order is a candidate', () => {
  const [d] = one([pkg()], [res(10, { bfmrOrderId: null })]);
  assert.equal(d.decision, 'exact');
});

test('unlinked reservation whose bfmrOrderId equals the order number is a candidate', () => {
  const [d] = one([pkg()], [res(10, { links: [] })]);
  assert.equal(d.decision, 'exact');
});

test('a link share smaller than the reservation limits this order to its share', () => {
  // reservation of 3: 1 unit belongs to this order, 2 to another
  const r = res(10, { qty: 3, links: [{ orderId: 1, quantity: 1, trackingNumber: null }, { orderId: 2, quantity: 2, trackingNumber: null }] });
  assert.equal(one([pkg()], [r])[0].decision, 'exact');
  assert.equal(manual(one([pkg({ items: [{ title: 'Acme Widget Pro 256GB', quantity: 2 }] })], [r])[0]).reason, 'quantity_over');
});

test('assumed quantity is exact but carries a caveat', () => {
  const [d] = one([pkg({ items: [{ title: 'Acme Widget Pro 256GB', quantity: 1, qtyAssumed: true }] })], [res(10)]);
  assert.equal(d.decision, 'exact');
  assert.equal(d.caveats.length, 1);
});

test('different orders are matched independently', () => {
  const pk = [pkg(), pkg({ orderId: 2, orderNumber: ORDER_B, trackingNumber: 'TBA000000000002' })];
  const rs = [res(10), res(11, { bfmrOrderId: ORDER_B, links: [{ orderId: 2, quantity: 1, trackingNumber: null }] })];
  const ds = one(pk, rs);
  assert.deepEqual(ds.map(d => d.decision), ['exact', 'exact']);
  assert.equal(ds[0].allocations[0].reservationId, 10);
  assert.equal(ds[1].allocations[0].reservationId, 11);
});

test('exact allocations always sum to the package units (wrong-quantity invariant)', () => {
  const cases: [PackageIn[], ReservationLineIn[]][] = [
    [[pkg()], [res(10)]],
    [[pkg({ items: [{ title: 'Acme Widget Pro 256GB', quantity: 3 }] })], [res(10, { reserveId: 'S', qty: 1, links: [] }), res(11, { reserveId: 'S', qty: 2, links: [] })]],
    [[1, 2].map(n => pkg({ trackingNumber: `TBA00000000010${n}` })), [res(10, { qty: 2, links: [] })]],
  ];
  for (const [p, r] of cases) {
    for (const [i, d] of matchPackages(p, r).entries()) {
      if (d.decision !== 'exact') continue;
      const want = p[i].items.reduce((s, it) => s + it.quantity, 0);
      assert.equal(d.allocations.reduce((s, a) => s + a.qty, 0), want);
    }
  }
});
