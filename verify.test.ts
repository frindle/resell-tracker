// Adversarial repo-style test for: bfmr-overcount   (node --test / tsx --test)
// Property: selectCanonicalBfmrLinks(links) drops phantom links (the no-tracking
// parent left after a split, and duplicates re-using another link's tracking)
// while leaving un-split and legitimately-multi-shipment reservations intact.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { selectCanonicalBfmrLinks } from './lib/bfmrLinkReconcile';

type L = { id: number; reservationId: number; trackingNumber: string | null; value?: number; quantity?: number };
const ids = (r: any[]) => r.map((x) => x.id).sort((a, b) => a - b);

// 1. Confirmed bug shape (orders 898/906/907: 4 links, 3 correct). Reservation 1
//    split into tracked children T2/T3; the no-tracking parent (id 1) is phantom.
test('drops the no-tracking parent when the reservation has tracked children', () => {
  const links: L[] = [
    { id: 1, reservationId: 1, trackingNumber: null },   // phantom parent
    { id: 2, reservationId: 1, trackingNumber: 'T2' },
    { id: 3, reservationId: 1, trackingNumber: 'T3' },
  ];
  const out = selectCanonicalBfmrLinks(links);
  assert.deepEqual(ids(out), [2, 3]);
  assert.ok(!out.some((l) => l.id === 1), 'phantom parent must be gone');
});

// 2. OVER-TRIGGER GUARD A: an un-split reservation (one no-tracking link, no
//    tracked children) must be returned UNCHANGED -- never emptied.
test('GUARD: un-split single no-tracking link is kept', () => {
  const links: L[] = [{ id: 10, reservationId: 5, trackingNumber: null, value: 42 }];
  const out = selectCanonicalBfmrLinks(links);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 10);
  assert.equal(out[0].value, 42, 'other fields preserved');
});

// 3. OVER-TRIGGER GUARD B: a legitimately multi-shipment reservation (parent
//    already removed, two distinct tracked children) stays fully intact.
test('GUARD: legitimate multi-shipment reservation kept intact', () => {
  const links: L[] = [
    { id: 20, reservationId: 7, trackingNumber: 'A' },
    { id: 21, reservationId: 7, trackingNumber: 'B' },
  ];
  assert.deepEqual(ids(selectCanonicalBfmrLinks(links)), [20, 21]);
});

// 4. Duplicate trackingNumber re-used across reservations: keep the smallest id,
//    drop the later duplicate (regardless of input order).
test('dedups a trackingNumber re-used by another reservation (keep smallest id)', () => {
  const a: L[] = [
    { id: 5, reservationId: 1, trackingNumber: 'DUP' },
    { id: 9, reservationId: 2, trackingNumber: 'DUP' },
  ];
  assert.deepEqual(ids(selectCanonicalBfmrLinks(a)), [5]);
  // reversed order -> same keeper
  assert.deepEqual(ids(selectCanonicalBfmrLinks([...a].reverse())), [5]);
});

// 5. Mixed: reservation 1 split (parent dropped), reservation 2 un-split single
//    no-tracking link (kept -- it has no tracked children of its own).
test('parent-drop is scoped per reservation', () => {
  const links: L[] = [
    { id: 1, reservationId: 1, trackingNumber: null },  // phantom (res 1 has T)
    { id: 2, reservationId: 1, trackingNumber: 'T' },
    { id: 3, reservationId: 2, trackingNumber: null },  // kept (res 2 un-split)
  ];
  assert.deepEqual(ids(selectCanonicalBfmrLinks(links)), [2, 3]);
});

// 6. Empty-string trackingNumber counts as no-tracking (a blank is not a real
//    shipment): treated as a parent, dropped when real tracked children exist.
test('empty-string trackingNumber is treated as no-tracking', () => {
  const links: L[] = [
    { id: 1, reservationId: 1, trackingNumber: '' },
    { id: 2, reservationId: 1, trackingNumber: 'T2' },
  ];
  assert.deepEqual(ids(selectCanonicalBfmrLinks(links)), [2]);
});

// 7. No mutation of the input array or its objects.
test('does not mutate input', () => {
  const links: L[] = [
    { id: 1, reservationId: 1, trackingNumber: null },
    { id: 2, reservationId: 1, trackingNumber: 'T2' },
  ];
  const snapshot = JSON.stringify(links);
  selectCanonicalBfmrLinks(links);
  assert.equal(JSON.stringify(links), snapshot, 'input array/objects unchanged');
});

// 8. Degenerate: empty array -> [].
test('empty input -> empty output', () => {
  assert.deepEqual(selectCanonicalBfmrLinks([] as L[]), []);
});

// 9. Preserves fields on kept tracked links.
test('preserves value/quantity on kept links', () => {
  const links: L[] = [
    { id: 1, reservationId: 1, trackingNumber: null },
    { id: 2, reservationId: 1, trackingNumber: 'T2', value: 100, quantity: 3 },
  ];
  const out = selectCanonicalBfmrLinks(links);
  const kept = out.find((l) => l.id === 2)!;
  assert.equal(kept.value, 100);
  assert.equal(kept.quantity, 3);
});
