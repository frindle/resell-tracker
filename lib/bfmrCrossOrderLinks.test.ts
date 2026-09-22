// Regression tests for the CROSS-ORDER exclusion in BFMR pricing
// (lib/bfmrCrossOrderLinks.ts, consumed by recalcBfmrSalePrice).
//
//   npm run test:bfmr-cross-order-links
//
// No test framework is installed in this repo, so these run on Node's built-in
// runner with type stripping - same convention as the other lib/*.test.ts.
//
// The defect: guardLink stops a cross-order link from being CREATED, but link
// 127 was created before that guard existed and is still in the live database.
// recalcBfmrSalePrice summed it, so the next recalc of order 219 would have
// written $1584 instead of $597. These tests pin the three cases that matter:
// a contradiction is excluded, a match is kept, and UNKNOWN is kept (7 of the
// 132 live links have no captured reservation order number and are correct).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dropContradictedLinks } from './bfmrCrossOrderLinks.ts';
import { selectCanonicalBfmrLinks } from './bfmrLinkReconcile.ts';

type Link = {
  id: number;
  reservationId: number;
  trackingNumber: string | null;
  quantity: number;
  value: number | null;
  reservationBfmrOrderId?: string | null;
  reservationTracking?: string | null;
};

const ORDER_219 = '112-2600594-9517060';

// The two links live on order 219 right now, field-for-field as the API
// reports them (GET /api/bfmr/reservations?orderId=219, read 2026-09-22):
//
//   reservation 103 "Apple Watch Series 11 - 46mm"  bfmrOrderId 112-8973564-0951402
//     link 127  qty 3  value 987  tracking TBA327676654858
//   reservation  98 "Apple AirPods Pro 3"           bfmrOrderId 112-2600594-9517060
//     link  69  qty 3  value 597  tracking TBA327676654858
//
// Both reservations report that same tracking number, so the endorsement rule
// in selectCanonicalBfmrLinks keeps BOTH - which is why the next recalc would
// have summed 987 + 597 = 1584 onto an order whose true payout is 597.
const LIVE_ORDER_219_LINKS: Link[] = [
  {
    id: 127,
    reservationId: 103,
    trackingNumber: 'TBA327676654858',
    quantity: 3,
    value: 987,
    reservationBfmrOrderId: '112-8973564-0951402',
    reservationTracking: 'TBA327676654858',
  },
  {
    id: 69,
    reservationId: 98,
    trackingNumber: 'TBA327676654858',
    quantity: 3,
    value: 597,
    reservationBfmrOrderId: '112-2600594-9517060',
    reservationTracking: 'TBA327676654858',
  },
];

/** The stages recalcBfmrSalePrice runs over its links, in its order. */
function priceLinks(links: Link[], orderNumber: string | null | undefined) {
  const kept = selectCanonicalBfmrLinks(dropContradictedLinks(links, orderNumber));
  // Mirrors the reduce in recalcBfmrSalePrice for links with a stored value
  // and no returned units (the shape of every link in these fixtures).
  const total = kept.reduce((sum, l) => sum + (l.value ?? 0), 0);
  return { keptIds: kept.map((l) => l.id).sort((a, b) => a - b), total };
}

// --- (a) a contradicting reservation order number is excluded ---

test('a link whose reservation names a DIFFERENT order is excluded from the price', () => {
  const links: Link[] = [
    { id: 1, reservationId: 10, trackingNumber: 'TBA1', quantity: 1, value: 100, reservationBfmrOrderId: ORDER_219 },
    { id: 2, reservationId: 11, trackingNumber: 'TBA2', quantity: 1, value: 987, reservationBfmrOrderId: '112-8973564-0951402' },
  ];
  const { keptIds, total } = priceLinks(links, ORDER_219);
  assert.deepEqual(keptIds, [1]);
  assert.equal(total, 100);
});

test('dropContradictedLinks reports each drop through onDrop', () => {
  const dropped: number[] = [];
  const kept = dropContradictedLinks(
    [
      { id: 1, reservationId: 10, reservationBfmrOrderId: ORDER_219 },
      { id: 2, reservationId: 11, reservationBfmrOrderId: '112-8973564-0951402' },
    ],
    ORDER_219,
    (l) => dropped.push(l.id),
  );
  assert.deepEqual(kept.map((l) => l.id), [1]);
  assert.deepEqual(dropped, [2]);
});

// --- (b) a matching reservation order number is still included ---

test('a link whose reservation names the SAME order is still counted', () => {
  const links: Link[] = [
    { id: 1, reservationId: 10, trackingNumber: 'TBA1', quantity: 1, value: 100, reservationBfmrOrderId: ORDER_219 },
    // Different formatting of the same number, and a ≥7-digit truncation:
    // both are the same order under the guard's comparison.
    { id: 2, reservationId: 11, trackingNumber: 'TBA2', quantity: 1, value: 200, reservationBfmrOrderId: '1122600594 9517060' },
    { id: 3, reservationId: 12, trackingNumber: 'TBA3', quantity: 1, value: 300, reservationBfmrOrderId: '112-2600594' },
  ];
  const { keptIds, total } = priceLinks(links, ORDER_219);
  assert.deepEqual(keptIds, [1, 2, 3]);
  assert.equal(total, 600);
});

// --- (c) UNKNOWN on either side is NOT a contradiction ---

test('UNKNOWN reservation order number stays in the price (not a blanket filter)', () => {
  // 7 of the 132 live links have no captured reservation order number and are
  // correct, wanted links. Absent, empty and too-short must all stay.
  for (const unknown of [undefined, null, '', '12345']) {
    const links: Link[] = [
      { id: 1, reservationId: 10, trackingNumber: 'TBA1', quantity: 1, value: 500, reservationBfmrOrderId: unknown as string | null | undefined },
    ];
    const { keptIds, total } = priceLinks(links, ORDER_219);
    assert.deepEqual(keptIds, [1], `reservation order number ${String(unknown)} must not be dropped`);
    assert.equal(total, 500);
  }
});

test('UNKNOWN on the ORDER side stays in the price too', () => {
  // Seven live orders carry 'N/A' or no order number at all; a reservation
  // that does name an order has nothing to contradict there.
  for (const orderNumber of [undefined, null, '', 'N/A', '12345']) {
    const links: Link[] = [
      { id: 1, reservationId: 10, trackingNumber: 'TBA1', quantity: 1, value: 500, reservationBfmrOrderId: '112-8973564-0951402' },
    ];
    const { keptIds, total } = priceLinks(links, orderNumber);
    assert.deepEqual(keptIds, [1], `order number ${String(orderNumber)} must not drop anything`);
    assert.equal(total, 500);
  }
});

// --- (d) the live incident, from link 127's actual field values ---

test('LIVE: order 219 prices at 597 with link 127 excluded, not 1584', () => {
  const { keptIds, total } = priceLinks(LIVE_ORDER_219_LINKS, ORDER_219);
  assert.deepEqual(keptIds, [69], 'link 127 (reservation 103, Apple Watch) must not be priced onto order 219');
  assert.equal(total, 597);
});

test('LIVE: without the exclusion the same rows price at 1584 (the bug this fixes)', () => {
  // Pins WHY the exclusion is needed: the canonical-link rules alone keep both
  // links, because both reservations genuinely endorse the shared tracking
  // number. Only the reservation's own order number separates them.
  const canonicalOnly = selectCanonicalBfmrLinks(LIVE_ORDER_219_LINKS);
  assert.deepEqual(canonicalOnly.map((l) => l.id).sort((a, b) => a - b), [69, 127]);
  assert.equal(canonicalOnly.reduce((s, l) => s + (l.value ?? 0), 0), 1584);
});
