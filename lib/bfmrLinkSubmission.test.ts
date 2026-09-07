/**
 * Tests for per-link BFMR submission state.
 *
 *   npm run test
 *
 * No test framework is installed in this repo, so these run on Node's built-in
 * runner with type stripping.
 *
 * The case that matters is the split shipment: a qty-2 reservation split into
 * a 2-unit link (has tracking) and a 1-unit link (no tracking). The old gate
 * was `r.remainingQty <= 0` — a whole-reservation fact rendered per-link — so
 * once the shipped sibling consumed the remaining qty, the un-shipped link
 * inherited "Fully submitted to BFMR — 2 of 2 shipped." A rule that only gets
 * one of the two links right is not a fix.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { linkSubmissionState } from './bfmrLinkSubmission.ts';

function reservation(over: Partial<{ qty: number; remainingQty: number; trackingNumber: string | null; status?: string }> = {}) {
  return {
    qty: 2,
    remainingQty: 0,
    trackingNumber: '1Z999AA10123456784',
    ...over,
  };
}

test('split shipment: the link with tracking is shipped', () => {
  // The 2-unit link carries its own tracking number. It is shipped regardless
  // of what the reservation-level remainingQty says.
  const s = linkSubmissionState(
    { trackingNumber: '1Z999AA10123456784', quantity: 2 },
    reservation(),
  );
  assert.equal(s.shipped, true);
});

test('split shipment: the un-tracked sibling is NOT shipped (the bug)', () => {
  // The reservation's remainingQty is 0 because the shipped sibling consumed
  // it. The old gate `r.remainingQty <= 0` rendered "Fully submitted to BFMR —
  // 2 of 2 shipped." on THIS link too. Per-link, this one has no tracking and
  // does not cover the whole reservation, so it must not claim shipped.
  const s = linkSubmissionState(
    { trackingNumber: null, quantity: 1 },
    reservation(),
  );
  assert.equal(s.shipped, false);
});

test('a fully-shipped single link is shipped', () => {
  // One link covers the whole qty-2 reservation and carries its own tracking.
  const s = linkSubmissionState(
    { trackingNumber: '1Z999AA10123456784', quantity: 2 },
    reservation({ remainingQty: 0 }),
  );
  assert.equal(s.shipped, true);
});

test('a not-yet-submitted single link is NOT shipped', () => {
  // Nothing has been submitted yet and the link has no tracking. The old gate
  // was false here too (remainingQty > 0), but this pins the per-link answer:
  // it must stay un-shipped even if some other reservation state changes.
  const s = linkSubmissionState(
    { trackingNumber: null, quantity: 2 },
    reservation({ remainingQty: 2, trackingNumber: null }),
  );
  assert.equal(s.shipped, false);
});

test('a whole-cover link with NO reservation tracking is NOT shipped (over-trigger guard)', () => {
  // The link covers the entire reservation but neither it nor the reservation
  // has a tracking number. Same notion as linkStatusLabel: covering the whole
  // reservation only inherits the reservation's tracking when there IS one.
  const s = linkSubmissionState(
    { trackingNumber: null, quantity: 2 },
    reservation({ trackingNumber: null }),
  );
  assert.equal(s.shipped, false);
});

test('a whole-cover link inherits the reservation\'s tracking', () => {
  // The other half of that rule: no link-level tracking, but the link covers
  // the whole reservation and the reservation itself has tracking.
  const s = linkSubmissionState(
    { trackingNumber: null, quantity: 2 },
    reservation({ trackingNumber: '1Z999AA10123456784' }),
  );
  assert.equal(s.shipped, true);
});

test('shipped never depends on the reservation-level remainingQty', () => {
  // The original bug in one assertion pair: identical link + reservation
  // tracking facts, different remainingQty (0 vs 2), must give the same answer.
  const withTracking = { trackingNumber: '1Z999AA10123456784', quantity: 1 };
  assert.equal(
    linkSubmissionState(withTracking, reservation({ remainingQty: 0 })).shipped,
    linkSubmissionState(withTracking, reservation({ remainingQty: 2 })).shipped,
  );
});

test('submittedUnits is the accurate count of units already submitted', () => {
  // qty-5 reservation with 3 left unsubmitted → 2 of 5. The old render was
  // hardcoded `{r.qty} of {r.qty}`, so it could never show a partial like this.
  const s = linkSubmissionState(
    { trackingNumber: '1Z999AA10123456784', quantity: 2 },
    reservation({ qty: 5, remainingQty: 3 }),
  );
  assert.equal(s.submittedUnits, 2);
  assert.equal(s.totalUnits, 5);
});

test('submittedUnits is clamped to [0, qty]', () => {
  // Defensive: a negative or over-claimed remainingQty must not produce a
  // nonsensical count like "-1 of 2" or "3 of 2".
  assert.equal(
    linkSubmissionState({ trackingNumber: null, quantity: 1 }, reservation({ qty: 2, remainingQty: -1 })).submittedUnits,
    2,
  );
  assert.equal(
    linkSubmissionState({ trackingNumber: null, quantity: 1 }, reservation({ qty: 2, remainingQty: 5 })).submittedUnits,
    0,
  );
});
