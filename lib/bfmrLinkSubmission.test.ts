/**
 * Tests for per-link BFMR submission state.
 *
 *   npm run test
 *
 * No test framework is installed in this repo, so these run on Node's built-in
 * runner with type stripping.
 *
 * The rule under test: a link is `shipped` ONLY when a real BfmrSubmittedShipment
 * (written by an actual POST to /api/bfmr/submit-reservation-tracking) matches its
 * tracking number — never from the mere presence of a locally-attached tracking
 * number. Live defect: reservation 9bUKQUHn8NH5xm5DMXcN_w== had submittedShipments=0
 * yet a link read "Fully submitted to BFMR" and lost its Submit button, because the
 * old code was `shipped = !!link.trackingNumber`. The split-shipment property must
 * also survive: an un-submitted sibling never inherits its shipped sibling's state.
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

test('split shipment: the link with a matching submittedShipment is shipped', () => {
  // The 2-unit link's tracking number has a real BfmrSubmittedShipment row. It
  // is shipped regardless of what the reservation-level remainingQty says.
  const s = linkSubmissionState(
    { trackingNumber: '1Z999AA10123456784', quantity: 2 },
    reservation(),
    [{ trackingNumber: '1Z999AA10123456784', qty: 2 }],
  );
  assert.equal(s.shipped, true);
});

test('split shipment: the un-tracked sibling is NOT shipped (the bug)', () => {
  // The reservation's remainingQty is 0 because the shipped sibling consumed
  // it. Per-link, this one has no tracking and does not cover the whole
  // reservation, so it must not claim shipped — even though its sibling did.
  const s = linkSubmissionState(
    { trackingNumber: null, quantity: 1 },
    reservation(),
    [{ trackingNumber: '1Z999AA10123456784', qty: 2 }],
  );
  assert.equal(s.shipped, false);
});

test('tracking attached locally but NOTHING submitted -> NOT shipped (the live bug)', () => {
  // The dropdown persisted a tracking number with no BFMR push. Old rule
  // `!!link.trackingNumber` rendered "Fully submitted to BFMR" and hid the
  // Submit button; correct answer is un-shipped so the user can still submit.
  const s = linkSubmissionState(
    { trackingNumber: 'TBA334421203888', quantity: 1 },
    reservation({ qty: 3, remainingQty: 3, trackingNumber: null }),
    [],
  );
  assert.equal(s.shipped, false);
});

test('a submittedShipment for a DIFFERENT tracking number does not ship this link', () => {
  // The link has its own tracking, but the only real submission is for another
  // number. Old rule -> true (has tracking); correct -> false.
  const s = linkSubmissionState(
    { trackingNumber: 'AAAA1111', quantity: 1 },
    reservation(),
    [{ trackingNumber: 'BBBB2222', qty: 1 }],
  );
  assert.equal(s.shipped, false);
});

test('a fully-shipped single link is shipped', () => {
  // One link covers the whole qty-2 reservation and its tracking number has a
  // real submission row.
  const s = linkSubmissionState(
    { trackingNumber: '1Z999AA10123456784', quantity: 2 },
    reservation({ remainingQty: 0 }),
    [{ trackingNumber: '1Z999AA10123456784', qty: 2 }],
  );
  assert.equal(s.shipped, true);
});

test('a not-yet-submitted single link is NOT shipped', () => {
  // Nothing has been submitted yet and the link has no tracking. It must stay
  // un-shipped even if some other reservation state changes.
  const s = linkSubmissionState(
    { trackingNumber: null, quantity: 2 },
    reservation({ remainingQty: 2, trackingNumber: null }),
    [],
  );
  assert.equal(s.shipped, false);
});

test('a whole-cover link with NO reservation tracking is NOT shipped (over-trigger guard)', () => {
  // The link covers the entire reservation but neither it nor the reservation
  // has a tracking number. Covering the whole reservation only inherits the
  // reservation's submission when there IS one matching its tracking.
  const s = linkSubmissionState(
    { trackingNumber: null, quantity: 2 },
    reservation({ trackingNumber: null }),
    [],
  );
  assert.equal(s.shipped, false);
});

test('a whole-cover link inherits the reservation\'s submittedShipment', () => {
  // The legacy path: no link-level tracking, but the link covers the whole
  // reservation and a real submission matches the reservation's own tracking.
  const s = linkSubmissionState(
    { trackingNumber: null, quantity: 2 },
    reservation({ trackingNumber: '1Z999AA10123456784' }),
    [{ trackingNumber: '1Z999AA10123456784', qty: 2 }],
  );
  assert.equal(s.shipped, true);
});

test('a whole-cover link does NOT inherit a submission for another tracking number', () => {
  // The other half of that rule: the reservation has tracking and there is a
  // real submission, but it matches neither this link nor the reservation.
  const s = linkSubmissionState(
    { trackingNumber: null, quantity: 2 },
    reservation({ trackingNumber: '1Z999AA10123456784' }),
    [{ trackingNumber: 'SOMEONE-ELSE', qty: 2 }],
  );
  assert.equal(s.shipped, false);
});

test('shipped never depends on the reservation-level remainingQty', () => {
  // Identical link + submission facts, different remainingQty (0 vs 2), must
  // give the same answer.
  const withTracking = { trackingNumber: '1Z999AA10123456784', quantity: 1 };
  const submissions = [{ trackingNumber: '1Z999AA10123456784', qty: 1 }];
  assert.equal(
    linkSubmissionState(withTracking, reservation({ remainingQty: 0 }), submissions).shipped,
    linkSubmissionState(withTracking, reservation({ remainingQty: 2 }), submissions).shipped,
  );
});

test('submittedUnits is the sum of submittedShipments qty', () => {
  // qty-5 reservation with two real submission rows (1 + 1) → 2 of 5. The old
  // render was hardcoded `{r.qty} of {r.qty}`, so it could never show a partial
  // like this; the old derivation `qty - remainingQty` also drifted from the
  // record when remainingQty wasn't decremented.
  const s = linkSubmissionState(
    { trackingNumber: '1Z999AA10123456784', quantity: 2 },
    reservation({ qty: 5, remainingQty: 3 }),
    [
      { trackingNumber: '1Z999AA10123456784', qty: 1 },
      { trackingNumber: 'SECOND-TRACKING', qty: 1 },
    ],
  );
  assert.equal(s.submittedUnits, 2);
  assert.equal(s.totalUnits, 5);
});

test('submittedUnits comes from the record even when remainingQty is stale', () => {
  // remainingQty deliberately "wrong" (not decremented): the count must still
  // come from the real submission rows.
  const s = linkSubmissionState(
    { trackingNumber: 'S-A', quantity: 2 },
    reservation({ qty: 3, remainingQty: 3 }),
    [{ trackingNumber: 'S-A', qty: 2 }],
  );
  assert.equal(s.submittedUnits, 2);
});

test('submittedUnits is clamped to [0, qty]', () => {
  // Defensive: no submissions -> 0; an over-claimed ledger (sum > qty) must not
  // produce a nonsensical count like "3 of 2".
  assert.equal(
    linkSubmissionState({ trackingNumber: null, quantity: 1 }, reservation({ qty: 2 }), []).submittedUnits,
    0,
  );
  assert.equal(
    linkSubmissionState(
      { trackingNumber: 'T', quantity: 1 },
      reservation({ qty: 2 }),
      [{ trackingNumber: 'T', qty: 3 }],
    ).submittedUnits,
    2,
  );
});

test('degenerate inputs do not throw', () => {
  // null tracking + empty submittedShipments -> not shipped, no throw.
  const s = linkSubmissionState({ trackingNumber: null, quantity: 1 }, reservation(), []);
  assert.equal(s.shipped, false);
  assert.equal(s.submittedUnits, 0);
});

// ---------------------------------------------------------------------------
// Over-allocation guard — the two confirmed incidents (2026-09).
//
// The old render-side predicate was `link.quantity > reservation.remainingQty`.
// remainingQty goes to 0 the moment a reservation is fully submitted OR carries
// BFMR's own tracking number, so EVERY link on such a row read "this link
// over-allocates what remains" — including rows that had submitted exactly
// their share. The rule under test now: overAllocated is true ONLY when the
// sum of THIS reservation's OWN submission records exceeds its OWN qty. A row
// where (submitted units) <= (that reservation's qty) must NEVER flag, and a
// genuinely over-submitted ledger (2 submitted vs qty 1) MUST still flag.
// ---------------------------------------------------------------------------

test('incident 111-5938021-0737010: qty-1 shipped row, 1 of 1 submitted -> NOT over-allocated', () => {
  // Reserve 5zW84gOTPN9y7Sr_ZBQHcA==: Qty 1, "shipped", tracking
  // 9361289725268124778591, "1 of 1 already submitted". It CANNOT over-allocate
  // anything — the old predicate (1 > remainingQty 0) flagged it anyway.
  const s = linkSubmissionState(
    { trackingNumber: '9361289725268124778591', quantity: 1 },
    reservation({ qty: 1, remainingQty: 0 }),
    [{ trackingNumber: '9361289725268124778591', qty: 1 }],
  );
  assert.equal(s.overAllocated, false);
});

test('incident 111-5938021-0737010: same row with NO local record (BFMR-side tracking) -> NOT over-allocated', () => {
  // remainingQty forced to 0 by the reservation's own trackingNumber, zero
  // BfmrSubmittedShipment rows. Submitted-for-this-reservation is 0 <= qty 1.
  const s = linkSubmissionState(
    { trackingNumber: '9361289725268124778591', quantity: 1 },
    reservation({ qty: 1, remainingQty: 0 }),
    [],
  );
  assert.equal(s.overAllocated, false);
});

test('revert guard: the OLD predicate flagged this exact row — the new one must not', () => {
  // Documents why the old code was wrong on this fixture and pins the fix:
  // with remainingQty 0 (fully submitted), `link.quantity > r.remainingQty` is
  // true, yet the reservation has submitted exactly its own qty. Reverting to
  // that predicate makes this test fail.
  const link = { trackingNumber: '9361289725268124778591', quantity: 1 };
  const r = reservation({ qty: 1, remainingQty: 0 });
  assert.equal(link.quantity > r.remainingQty, true); // old predicate: false positive
  assert.equal(
    linkSubmissionState(link, r, [{ trackingNumber: '9361289725268124778591', qty: 1 }]).overAllocated,
    false,
  );
});

test('genuinely over-submitted (2 submitted vs qty 1) MUST still be flagged — revert test', () => {
  // The guard must bite on a real over-allocation. remainingQty clamps at 0 so
  // the flag has to come from the unclamped ledger sum, not from it.
  const s = linkSubmissionState(
    { trackingNumber: 'T-1', quantity: 1 },
    reservation({ qty: 1, remainingQty: 0 }),
    [
      { trackingNumber: 'T-1', qty: 1 },
      { trackingNumber: 'T-2', qty: 1 },
    ],
  );
  assert.equal(s.overAllocated, true);
});

test('incident 111-3026367-4750648 (3 reserved): no row may flag over-allocation', () => {
  // Apple iPad Air 8: purchased qty-1 (0 submitted), shipped split half qty-2
  // (2 of 2 submitted), and the awaiting-tracking link on that fully-submitted
  // half. Every row has submitted <= its own reservation's qty, so none may
  // read "over-allocates what remains" — two of them did under the old check.
  const rows = [
    linkSubmissionState(
      { trackingNumber: null, quantity: 1 },
      reservation({ qty: 1, remainingQty: 1 }),
      [],
    ),
    linkSubmissionState(
      { trackingNumber: 'SPLIT-2', quantity: 2 },
      reservation({ qty: 2, remainingQty: 0 }),
      [{ trackingNumber: 'SPLIT-2', qty: 2 }],
    ),
    linkSubmissionState(
      { trackingNumber: null, quantity: 1 },
      reservation({ qty: 2, remainingQty: 0 }),
      [{ trackingNumber: 'SPLIT-2', qty: 2 }],
    ),
  ];
  for (const r of rows) assert.equal(r.overAllocated, false);
});

test('over-allocation never pools across reservations on the same order', () => {
  // Order 111-5938021-0737010: reserve A qty-3 (0 submitted) and reserve B
  // qty-1 (1 of 1 submitted). Each row's flag must depend only on its own
  // reservation's ledger — B is fully but exactly submitted, A untouched.
  const a = linkSubmissionState(
    { trackingNumber: null, quantity: 3 },
    reservation({ qty: 3, remainingQty: 3 }),
    [],
  );
  const b = linkSubmissionState(
    { trackingNumber: '9361289725268124778591', quantity: 1 },
    reservation({ qty: 1, remainingQty: 0 }),
    [{ trackingNumber: '9361289725268124778591', qty: 1 }],
  );
  assert.equal(a.overAllocated, false);
  assert.equal(b.overAllocated, false);

  // And the same order with B genuinely over-submitted (2 vs qty 1): only B
  // flags; A's untouched ledger stays clean.
  const bOver = linkSubmissionState(
    { trackingNumber: '9361289725268124778591', quantity: 1 },
    reservation({ qty: 1, remainingQty: 0 }),
    [
      { trackingNumber: '9361289725268124778591', qty: 1 },
      { trackingNumber: 'EXTRA-UNIT', qty: 1 },
    ],
  );
  assert.equal(a.overAllocated, false);
  assert.equal(bOver.overAllocated, true);
});
