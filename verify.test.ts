// Adversarial repo-style test for: rt-bfmr-pending-sync-scope-s1-the-exact-13-value-enum   (node --test / tsx --test)
//
// The target is a PURE DATA module by intent (no imports, no functions beyond
// what earlier slices landed), so the adversarial surface here is the exported
// constant itself: exact values, exact ORDER, and that the joined form matches
// the route's TrackerFilter string byte-for-byte. A plausible-but-wrong impl
// (reordered list, a missing/extra status, `as const` dropped) must fail one
// of these cases. The last case is the over-trigger guard: earlier slices'
// landed work in this same file must still behave exactly as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BFMR_ALL_TRACKER_STATUSES,
  parseBfmrSyncScope,
} from './lib/bfmrSyncScope';
import type { BfmrTrackerStatus } from './lib/bfmrSyncScope';

// The exact 13-value enum the route pages over today (route.ts line 45), in order.
const EXPECTED = [
  'purchased',
  'reserved',
  'return',
  'payment_error',
  'shipped',
  'processed',
  'set_aside',
  'paid',
  'cancelled',
  'returned',
  'closed',
  'deadline',
  'pkg_received',
];

test('BFMR_ALL_TRACKER_STATUSES is exactly the 13 statuses, in this order', () => {
  assert.ok(Array.isArray(BFMR_ALL_TRACKER_STATUSES), 'must be an array');
  assert.equal(BFMR_ALL_TRACKER_STATUSES.length, 13);
  // deepEqual on arrays is ORDER-sensitive -- a reordered enum fails here.
  assert.deepEqual([...BFMR_ALL_TRACKER_STATUSES], EXPECTED);
});

test('join(",") reproduces the route\'s TrackerFilter status string byte-for-byte', () => {
  const ROUTE_FILTER = 'purchased,reserved,return,payment_error,shipped,processed,set_aside,paid,cancelled,returned,closed,deadline,pkg_received';
  assert.equal(BFMR_ALL_TRACKER_STATUSES.join(','), ROUTE_FILTER);
});

test('BfmrTrackerStatus is the member type of the tuple (all 13 assignable)', () => {
  // Compile-time pin: each element must be a BfmrTrackerStatus. If `as const`
  // were dropped, this file would not type-check and verify.sh's tsc gate fails;
  // at runtime we also assert every value round-trips through the union.
  const members: BfmrTrackerStatus[] = [...BFMR_ALL_TRACKER_STATUSES];
  for (const v of EXPECTED) {
    assert.ok(members.includes(v as BfmrTrackerStatus), `missing member ${v}`);
  }
});

test('over-trigger guard: earlier slices\' parseBfmrSyncScope is unchanged', () => {
  // The refimpl must ADD, not rewrite -- pin the landed behaviour.
  assert.equal(parseBfmrSyncScope('all'), 'all');
  assert.equal(parseBfmrSyncScope('pending'), 'pending');
  assert.equal(parseBfmrSyncScope('bogus'), 'all');
  assert.equal(parseBfmrSyncScope(undefined), 'all');
});
