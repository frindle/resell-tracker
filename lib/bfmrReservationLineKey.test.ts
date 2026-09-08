/**
 * Tests for BFMR reservation line keying + first-wins dedupe.
 *
 *   npm run test
 *
 * No test framework is installed in this repo, so these run on Node's built-in
 * runner with type stripping (same as bfmrLinkSubmission.test.ts).
 *
 * The rule under test: after sync dedupes the raw BFMR lines for one reserve_id,
 * the sum of derived line qtys must equal what BFMR itself counts as reserved —
 * never more. Two live shapes pin this down:
 *   - order 111-3026367-4750648 (Apple iPad Air 8): BFMR's own site shows 3
 *     reserved, but the raw feed re-lists one of those units a second time;
 *     without first-wins collapse the reserve renders as 4.
 *   - the split-separation fix (e659e69/f5f5e84) must survive: genuine split
 *     halves that share a reserve_id but differ on purchase/shipment stay
 *     separate rows — dedupe may only collapse lines identical on all three
 *     key segments.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { reservationLineKey, dedupeReservationLines } from './bfmrReservationLineKey.ts';

const RESERVE = 'g3F6V0aDstt7feiyM1VJNA=='; // order 111-3026367-4750648

test('order 111-3026367-4750648: 3 reserved must not derive as 4 (shipped-2 split + purchased-1 + awaiting-1)', () => {
  // BFMR's own site counts exactly 3 reserved units for this reserve_id. The
  // raw feed carries the shipped "Split" half (qty 2) plus ONE unshipped unit
  // that BFMR lists under two statuses across its filter pages — once as
  // "purchased", once as "awaiting tracking". Both appearances are identical on
  // all three key segments, so first-wins dedupe must collapse them into a
  // single line. Keeping both is exactly the live over-count: the reserve
  // renders as 1 + 2 + 1 = 4 against BFMR's ground truth of 3.
  const rawLines = [
    { reserve_id: RESERVE, purchase_id: 'P-1', qty: 1 },                        // "purchased" appearance of the unshipped unit (0 of 1 submitted)
    { reserve_id: RESERVE, purchase_id: 'P-2', shipment_id: 'S-1', qty: 2 },    // shipped "Split" half (2 of 2 submitted)
    // Same reserved unit re-listed as "awaiting tracking" under another filter
    // page — identical on reserve_id + purchase_id + shipment_id. Must collapse
    // into the first line, not survive as a fourth unit.
    { reserve_id: RESERVE, purchase_id: 'P-1', qty: 1 },
  ];

  const derived = dedupeReservationLines(rawLines);
  assert.equal(derived.length, 2);
  // The accounting invariant: derived total == BFMR's reserved quantity (3),
  // never the 4 the un-deduped feed would render.
  assert.equal(derived.reduce((sum, l) => sum + Number(l.qty), 0), 3);
});

test('genuine split halves still survive dedupe (the e659e69 fix is not reverted)', () => {
  // A shipped purchase and its unshipped remainder share reserve_id AND
  // purchase_id but differ on shipment_id — they are two distinct lines BFMR
  // counts separately, so both must remain. Collapsing them would under-count.
  const rawLines = [
    { reserve_id: RESERVE, purchase_id: 'P-2', shipment_id: 'S-1', qty: 2 }, // shipped half
    { reserve_id: RESERVE, purchase_id: 'P-2', shipment_id: null, qty: 1 },  // unshipped remainder
  ];

  const derived = dedupeReservationLines(rawLines);
  assert.equal(derived.length, 2);
  assert.equal(derived.reduce((sum, l) => sum + Number(l.qty), 0), 3);
});

test('an exact refetch of every line collapses to one row each', () => {
  // The dedupe exists for the common case: the same page returned under two
  // filters. Every line identical on all three segments -> one survivor,
  // first-wins (the kept object is the first occurrence).
  const first = { reserve_id: RESERVE, purchase_id: 'P-1', qty: 1, status: 'purchased' };
  const refetch = { reserve_id: RESERVE, purchase_id: 'P-1', qty: 1, status: 'purchased' };

  const derived = dedupeReservationLines([first, refetch]);
  assert.equal(derived.length, 1);
  assert.equal(derived[0], first); // first-wins identity
});

test('reservationLineKey falls back to purchase_id then shipment_id when reserve_id is absent', () => {
  // Head-segment fallback keeps lines without a reserve_id separable from each
  // other and stable across refetches.
  assert.equal(
    reservationLineKey({ purchase_id: 'P-9', shipment_id: 'S-9' }),
    'P-9|P-9|S-9',
  );
  assert.equal(reservationLineKey({ shipment_id: 'S-only' }), 'S-only||S-only');
});
