// Adversarial repo-style test for: rt-bfmr-pending-sync-scope-s3-export-function-resolveb   (node --test / tsx --test)
//
// Pins resolveBfmrSyncPlan's exact contract: the 'all' scope must emit ONE
// filter built from the BFMR_ALL_TRACKER_STATUSES constant (never a re-typed
// status literal), and the narrow/unlinked ('pending') scope must use
// quick_filter 'action_needed' -- NOT 'pending'. The flags differ per scope.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveBfmrSyncPlan, BFMR_ALL_TRACKER_STATUSES } from './lib/bfmrSyncScope';

test("'all' scope: single filter built from the s1 constant, all three runs on", () => {
  const plan = resolveBfmrSyncPlan('all');
  assert.equal(plan.filters.length, 1);
  // deepStrictEqual catches extra keys (e.g. a stray quick_filter) and any
  // re-typed status string that drifts from the constant's order/values.
  assert.deepEqual(
    plan.filters[0],
    { status: BFMR_ALL_TRACKER_STATUSES.join(','), page_size: 200 },
  );
  assert.equal(plan.runWebBackfill, true);
  assert.equal(plan.runStaleLinkScan, true);
  assert.equal(plan.runAutoLink, true);
});

test("'all' scope status string is exactly the constant join (13 statuses, in order)", () => {
  const expected = 'purchased,reserved,return,payment_error,shipped,processed,set_aside,paid,cancelled,returned,closed,deadline,pkg_received';
  assert.equal(BFMR_ALL_TRACKER_STATUSES.join(','), expected);
  const plan = resolveBfmrSyncPlan('all');
  assert.equal(plan.filters[0].status, expected);
  // quick_filter must be ABSENT for the 'all' scope -- BFMR ignores it when
  // status is set, and its presence would signal a mixed-up filter.
  assert.ok(!('quick_filter' in plan.filters[0]));
});

test("'pending' (narrow/unlinked) scope: quick_filter 'action_needed', no status, backfill+scan off", () => {
  const plan = resolveBfmrSyncPlan('pending');
  assert.equal(plan.filters.length, 1);
  // The corrected filter -- a plausible wrong fix emits quick_filter:'pending'
  // or reuses the 'all' scope's status filter; both fail here.
  assert.deepEqual(
    plan.filters[0],
    { quick_filter: 'action_needed', page_size: 200 },
  );
  assert.ok(!('status' in plan.filters[0]));
  assert.equal(plan.runWebBackfill, false);
  assert.equal(plan.runStaleLinkScan, false);
  // Auto-link still runs on the narrow scope -- it is what links the rows.
  assert.equal(plan.runAutoLink, true);
});

test("over-trigger guard: scopes never bleed into each other's plans", () => {
  const all = resolveBfmrSyncPlan('all');
  const pending = resolveBfmrSyncPlan('pending');
  // 'all' must not carry the narrow filter; 'pending' must not carry the full
  // status enum. One-directional fixes (same plan for both scopes) fail here.
  assert.notDeepEqual(all.filters, pending.filters);
  assert.equal(pending.filters[0].quick_filter, 'action_needed');
  assert.equal(all.filters[0].status, BFMR_ALL_TRACKER_STATUSES.join(','));
});
