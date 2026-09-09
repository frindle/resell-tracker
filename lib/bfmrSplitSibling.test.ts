/**
 * Regression tests for the BFMR split phantom-link defect (orders 898/907/906).
 *
 *   npm run test:bfmr-split-sibling
 *
 * No test framework is installed in this repo, so these run on Node's built-in
 * runner with type stripping — same convention as the other lib/*.test.ts.
 *
 * The defect: a BFMR "purchased" reservation split into per-shipment child rows
 * (each with its own tracking number) syncs to SEPARATE BfmrReservation rows
 * sharing one reserve_id, while the pre-split no-tracking parent row stays
 * behind locally. autoLinkBfmrReservations then linked every unlinked row by
 * bfmrOrderId — guardLink's two invariants both passed for the stale parent
 * (different reservationId → no over-allocation; no tracking → no duplicate) —
 * so recalcBfmrSalePrice summed parent + children:
 *   - order 898: 3 shipped links @186 + phantom parent qty3/$558 → $1116 (true $558)
 *   - order 907: qty1/$631 + qty2/$1262 + phantom parent qty1/$631 → $2524 (true $1893)
 *   - order 906: res B picked up res A's tracking TBA334421203888 on a second link → $2524 (true $1893)
 *
 * These tests pin the two new invariants in lib/bfmrLinkGuard.ts and the
 * duplicate-tracking guard they back. They fail if the fix is reverted:
 * splitSiblingCoverage/staleSiblingAdjustments no longer exist, or stop
 * distinguishing stale parents from legitimate split remainders.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { guardLink, splitSiblingCoverage, staleSiblingAdjustments } from './bfmrLinkGuard.ts';

const OLD_SYNC = 1_700_000_000_000; // pre-split sync (stale parent row)
const NEW_SYNC = OLD_SYNC + 86_400_000; // the split's child rows, just synced

// Order 898 shape: reserveId EWiuTr2yICyPguahzVQtaQ== — three shipped child
// links (qty1 @ $186 each) already on the order, stale no-tracking parent
// (qty3, $558) arriving for auto-link.
const RESERVE_898 = 'EWiuTr2yICyPguahzVQtaQ==';
const links898 = [
  { id: 101, reservationId: 701, quantity: 1, trackingNumber: 'TBA334421203881', reserveId: RESERVE_898, lastSyncedAtMs: NEW_SYNC },
  { id: 102, reservationId: 702, quantity: 1, trackingNumber: 'TBA334421203882', reserveId: RESERVE_898, lastSyncedAtMs: NEW_SYNC },
  { id: 103, reservationId: 703, quantity: 1, trackingNumber: 'TBA334421203883', reserveId: RESERVE_898, lastSyncedAtMs: NEW_SYNC },
];

test('order-898 class: stale untracked parent fully covered by tracked siblings is skipped', () => {
  const coverage = splitSiblingCoverage(links898, { reservationId: 700 /*parent*/, quantity: 3, reserveId: RESERVE_898 });
  // The auto-link skip condition is `coverage >= candidate qty`.
  assert.equal(coverage, 3);
  assert.ok(coverage >= 3, 'phantom parent must be skipped — its units are already counted via the children');
});

test('a legitimate split remainder (partially covered) still links', () => {
  // qty-3 line split into shipped half (qty1, tracked) + unshipped remainder
  // (qty2, no tracking). The remainder must NOT be treated as a stale parent:
  // coverage is only 1 of its 2 units.
  const links = [
    { id: 201, reservationId: 801, quantity: 1, trackingNumber: 'TBA334421203900', reserveId: 'FAM==', lastSyncedAtMs: NEW_SYNC },
  ];
  const coverage = splitSiblingCoverage(links, { reservationId: 802 /*remainder*/, quantity: 2, reserveId: 'FAM==' });
  assert.equal(coverage, 1);
  assert.ok(coverage < 2, 'legitimate remainder must still be linkable — no undercount');
});

test('sibling links from a DIFFERENT reserve_id family never count as coverage', () => {
  const otherFamily = [
    { id: 301, reservationId: 901, quantity: 5, trackingNumber: 'TBA334421203999', reserveId: 'OTHER==', lastSyncedAtMs: NEW_SYNC },
  ];
  assert.equal(splitSiblingCoverage(otherFamily, { reservationId: 900, quantity: 3, reserveId: RESERVE_898 }), 0);
});

test('no reserve_id (null) means no family — coverage is always zero', () => {
  const links = [
    { id: 401, reservationId: 501, quantity: 3, trackingNumber: null, reserveId: null, lastSyncedAtMs: NEW_SYNC },
  ];
  assert.equal(splitSiblingCoverage(links, { reservationId: 500, quantity: 3, reserveId: null }), 0);
});

test('order-898 class (reverse arrival): fresh tracked child supersedes the stale untracked parent link', () => {
  // Parent linked FIRST (qty3/$558, synced before the split), then each child
  // arrives. Each must shrink the stale parent by its own qty — never touch a
  // current row — so the final set is exactly the three children and sums to $558.
  const parent = { id: 601, reservationId: 700, quantity: 3, trackingNumber: null, reserveId: RESERVE_898, lastSyncedAtMs: OLD_SYNC };

  let a = staleSiblingAdjustments([parent], { reservationId: 701, quantity: 1, reserveId: RESERVE_898, lastSyncedAtMs: NEW_SYNC });
  assert.deepEqual(a, [{ linkId: 601, newQuantity: 2 }]);

  a = staleSiblingAdjustments([{ ...parent, quantity: 2 }], { reservationId: 702, quantity: 1, reserveId: RESERVE_898, lastSyncedAtMs: NEW_SYNC });
  assert.deepEqual(a, [{ linkId: 601, newQuantity: 1 }]);

  a = staleSiblingAdjustments([{ ...parent, quantity: 1 }], { reservationId: 703, quantity: 1, reserveId: RESERVE_898, lastSyncedAtMs: NEW_SYNC });
  assert.deepEqual(a, [{ linkId: 601, newQuantity: 0 }]); // fully covered → delete
});

test('a CURRENT untracked sibling (equal sync timestamp) is never shrunk', () => {
  // Legitimate split remainder synced in the SAME pass as the child — shrinking
  // it would undercount the order. Only strictly-earlier rows are stale.
  const remainder = { id: 701, reservationId: 802, quantity: 2, trackingNumber: null, reserveId: 'FAM==', lastSyncedAtMs: NEW_SYNC };
  assert.deepEqual(
    staleSiblingAdjustments([remainder], { reservationId: 801, quantity: 1, reserveId: 'FAM==', lastSyncedAtMs: NEW_SYNC }),
    [],
  );
});

test('a tracked sibling is never treated as a stale parent', () => {
  const trackedSibling = { id: 801, reservationId: 951, quantity: 3, trackingNumber: 'TBA334421204000', reserveId: RESERVE_898, lastSyncedAtMs: OLD_SYNC };
  assert.deepEqual(
    staleSiblingAdjustments([trackedSibling], { reservationId: 952, quantity: 1, reserveId: RESERVE_898, lastSyncedAtMs: NEW_SYNC }),
    [],
  );
});

test('order-906 class: a tracking number already on another reservation\'s link is rejected', () => {
  // res A's shipped link carries TBA334421203888; linking res B with the SAME
  // tracking must be refused — that duplicate was what inflated order 906.
  const orderLinks = [
    { id: 1, reservationId: 1001 /*res A*/, quantity: 1, trackingNumber: 'TBA334421203888' },
  ];
  const guard = guardLink(orderLinks, {
    orderId: 906,
    reservationId: 1002 /*res B*/,
    quantity: 1,
    trackingNumber: 'tba334421203888', // case/whitespace-insensitive match
    reservationQty: 2,
  });
  assert.equal(guard.ok, false);
  if (!guard.ok) assert.match(guard.reason, /duplicate tracking TBA334421203888/);
});

test('an untracked candidate with no siblings still links (baseline unchanged)', () => {
  const guard = guardLink([], {
    orderId: 907, reservationId: 1101, quantity: 1, trackingNumber: null, reservationQty: 1,
  });
  assert.equal(guard.ok, true);
});
