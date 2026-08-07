// Self-check for the partial-return money math. Pure functions only — no DB.
// Run: npx tsc --noEmit (types) and `npx next build` compile it; to execute:
//   npx tsx lib/orderReturns.check.ts     (or paste into a node REPL)
// Kept framework-free on purpose; the DB paths are verified end-to-end
// through /api/orders/:id/returns.
import assert from 'node:assert/strict';
import { proratedLinkValue, returnedCostFor, mapAmazonReturnStatus, clampReturnsToLines } from './orderReturns';
import { hasOpenReturns, isFullyReturned } from './returnStatus';

// --- order 832: $854 for 3 units, $900 payout, 1 unit returned -------------
const perUnitCost832 = 854 / 3;

// Payout must follow the REMAINING units, not the whole link.
assert.equal(proratedLinkValue(900, 3, 2), 600);
assert.equal(proratedLinkValue(900, 3, 3), 900);
assert.equal(proratedLinkValue(900, 3, 0), 0);
// Guard against the value-is-a-per-unit-rate misreading: 900 * 2 would be 1800.
assert.notEqual(proratedLinkValue(900, 3, 2), 1800);

// In-flight return writes off the per-unit cost, so cost tracks the 2-of-3
// reality: 854 - 284.67 = 569.33 (= 2/3 of 854).
assert.equal(
  returnedCostFor([{ status: 'in_transit', quantity: 1, refundAmount: null }], perUnitCost832),
  284.67,
);
// Once refunded, the ACTUAL refund wins over the estimate (restocking fee).
assert.equal(
  returnedCostFor([{ status: 'refunded', quantity: 1, refundAmount: 280 }], perUnitCost832),
  280,
);
// Margin sanity: 2 units sold at 600 against 569.33 of cost = 30.67,
// exactly 2/3 of the original 46.00 margin.
assert.equal(Math.round((600 - (854 - 284.67)) * 100) / 100, 30.67);

// --- the "3 paid but 1 rejected, in transit back" order --------------------
// Rejected units are NOT a completed sale...
assert.equal(proratedLinkValue(900, 3, 2), 600);
// ...but no retailer refund exists yet, so the money is still out the door:
// nothing is written off the cost basis.
assert.equal(
  returnedCostFor([{ status: 'rejected', quantity: 1, refundAmount: null }], 200),
  0,
);

// --- partial refunds and full-line returns ---------------------------------
// 4 units / $400 (=$100/unit) / $500 link payout, 2 returned.
assert.equal(proratedLinkValue(500, 4, 2), 250);
// Refunded at $180 (restocking fee): the ACTUAL refund is the write-off, not
// the $200 estimate — effective cost 400-180 = 220 against 250 of sale.
assert.equal(returnedCostFor([{ status: 'refunded', quantity: 2, refundAmount: 180 }], 100), 180);
// Whole line returned: zero payout, full basis written off, no NaN/divide-by-zero.
assert.equal(proratedLinkValue(500, 4, 0), 0);
assert.equal(returnedCostFor([{ status: 'in_transit', quantity: 4, refundAmount: null }], 100), 400);
// Two sequential 1-unit returns on one line must not drift: 2 x 284.666… still
// rounds once, to exactly 2/3 of 854.
assert.equal(returnedCostFor(
  [{ status: 'requested', quantity: 1, refundAmount: null },
   { status: 'requested', quantity: 1, refundAmount: null }],
  perUnitCost832,
), 569.33);

// --- returns whose line shrank or vanished ---------------------------------
const line3 = [{ key: 'bfmr:1', quantity: 3 }];
const ret2 = [{ bfmrLinkId: 1, commitmentLinkId: null, quantity: 2 }];
// Normal case: line still covers the return, nothing is dropped.
assert.deepEqual(clampReturnsToLines(ret2, line3), ret2);
// Link PATCHed from 3 units down to 1 with 2 already returned: only 1 unit can
// still be charged. Uncapped this wrote off 2 x the whole order cost, since the
// per-unit denominator had collapsed to the single remaining unit.
assert.deepEqual(
  clampReturnsToLines(ret2, [{ key: 'bfmr:1', quantity: 1 }]),
  [{ bfmrLinkId: 1, commitmentLinkId: null, quantity: 1 }],
);
// Link unlinked entirely: the orphaned row writes off nothing.
assert.deepEqual(clampReturnsToLines(ret2, [{ key: 'order', quantity: 1 }]), []);
// Allowance is consumed oldest-first, not re-granted per row.
assert.deepEqual(
  clampReturnsToLines(
    [{ bfmrLinkId: 1, commitmentLinkId: null, quantity: 2 },
     { bfmrLinkId: 1, commitmentLinkId: null, quantity: 2 }],
    line3,
  ).map(r => r.quantity),
  [2, 1],
);
// Whole-order (synthetic) line returns key off both-null and are covered too.
assert.deepEqual(
  clampReturnsToLines([{ bfmrLinkId: null, commitmentLinkId: null, quantity: 5 }], [{ key: 'order', quantity: 2 }]),
  [{ bfmrLinkId: null, commitmentLinkId: null, quantity: 2 }],
);

// --- Amazon status text -> our lifecycle -----------------------------------
assert.deepEqual(
  mapAmazonReturnStatus('Return requested for 1 of 3 items'),
  { status: 'requested', quantity: 1, of: 3 },
);
assert.equal(mapAmazonReturnStatus('Refund issued').status, 'refunded');
assert.equal(mapAmazonReturnStatus('Package in transit').status, 'in_transit');
assert.equal(mapAmazonReturnStatus('Your return was rejected').status, 'rejected');
assert.equal(mapAmazonReturnStatus('Delivered').status, null);

// --- list-view predicates (replaced the retired Order.returnStatus reads) ---
// Open = needs attention. Both terminal states drop out.
assert.equal(hasOpenReturns([{ status: 'requested' }]), true);
assert.equal(hasOpenReturns([{ status: 'received' }]), true);
assert.equal(hasOpenReturns([{ status: 'refunded' }, { status: 'rejected' }]), false);
assert.equal(hasOpenReturns([]), false);

// Fully returned = every unit came back, so payout checks must skip the order
// (salePrice is recomputed to ~0 while bgExpectedPayout keeps the original).
assert.equal(isFullyReturned([{ quantity: 3 }], [3]), true);
assert.equal(isFullyReturned([{ quantity: 1 }, { quantity: 2 }], [2, 1]), true);
assert.equal(isFullyReturned([{ quantity: 2 }], [3]), false);
assert.equal(isFullyReturned([], [3]), false);
// Unlinked order: no link rows means the synthetic whole-order line, 1 unit.
assert.equal(isFullyReturned([{ quantity: 1 }], []), true);
assert.equal(isFullyReturned([], []), false);

console.log('orderReturns self-check OK');
