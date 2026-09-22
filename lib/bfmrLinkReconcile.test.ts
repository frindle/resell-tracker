// Regression tests for the BFMR duplicate-tracking collision rule
// (orders 929 / 906 / 767, confirmed live 2026-09-22).
//
//   npm run test:bfmr-link-reconcile
//
// No test framework is installed in this repo, so these run on Node's built-in
// runner with type stripping — same convention as the other lib/*.test.ts.
//
// Pins the reservation-ENDORSEMENT collision rule in selectCanonicalBfmrLinks:
//  - multiple reservations shipping together under ONE tracking number are all
//    kept when each reservation row itself reports that tracking number;
//  - an unendorsed stale mislink sharing a tracking with an endorsed link is
//    still dropped (the old smallest-id behaviour must not regress);
//  - with NO endorsement data at all, legacy smallest-id-wins is preserved.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { selectCanonicalBfmrLinks } from './bfmrLinkReconcile.ts';
import type { BfmrLinkLike } from './bfmrLinkReconcile.ts';

const ids = (links: BfmrLinkLike[]) => links.map((l) => l.id);

test('keeps every endorsed link sharing one tracking number (order 929 shape)', () => {
  // Two separate reservations, units ship together under ONE tracking number;
  // BFMR put that exact tracking on BOTH reservation rows -> both are real.
  const a = { id: 188, reservationId: 307956, trackingNumber: '9339589725268581127361', reservationTracking: '9339589725268581127361' };
  const b = { id: 189, reservationId: 307955, trackingNumber: '9339589725268581127361', reservationTracking: '9339589725268581127361' };
  const out = selectCanonicalBfmrLinks([a, b]);
  assert.deepEqual(ids(out), [188, 189], 'both endorsed links must survive (true total 2352, not 1176)');
});

test('drops an unendorsed stale mislink when a sibling IS endorsed (order 906 shape)', () => {
  // Link 153's reservation has NO tracking of its own -> NOT endorsed.
  // Link 190's reservation reports the shared tracking -> endorsed, kept.
  const stale = { id: 153, reservationId: 164353, trackingNumber: '1Z82AA931379787130', reservationTracking: null };
  const real = { id: 190, reservationId: 238161, trackingNumber: '1Z82AA931379787130', reservationTracking: '1Z82AA931379787130' };
  const out = selectCanonicalBfmrLinks([stale, real]);
  assert.deepEqual(ids(out), [190], 'unendorsed mislink must be dropped (true total 1893, not 3155)');
});

test('drops unendorsed links whose claimed tracking belongs to another endorsed reservation (order 767 shape)', () => {
  // Links 104/105 sit on reservation 6480 (own tracking ...2225) but claim
  // trackings that belong to reservations 216284 / 216283, which endorse them.
  const misA = { id: 104, reservationId: 6480, trackingNumber: '9339589725265621788780', reservationTracking: '9339589725265621672225' };
  const ownA = { id: 200, reservationId: 216284, trackingNumber: '9339589725265621788780', reservationTracking: '9339589725265621788780' };
  const misB = { id: 105, reservationId: 6480, trackingNumber: '9339589725265622369872', reservationTracking: '9339589725265621672225' };
  const ownB = { id: 201, reservationId: 216283, trackingNumber: '9339589725265622369872', reservationTracking: '9339589725265622369872' };
  const out = selectCanonicalBfmrLinks([misA, ownA, misB, ownB]);
  assert.deepEqual(ids(out), [200, 201], 'both unendorsed links must be dropped (order totals 1196, not 1794)');
});

test('falls back to smallest-id when NO link in the group is endorsed', () => {
  // No reservation-level tracking data at all -> legacy behaviour preserved.
  const small = { id: 50, reservationId: 11, trackingNumber: 'T-1' };
  const big = { id: 60, reservationId: 22, trackingNumber: 't-1 ' }; // normalize: same group
  assert.deepEqual(ids(selectCanonicalBfmrLinks([big, small])), [50], 'no endorsement data -> smallest id wins');

  // One link HAS a reservationTracking but it does NOT match the group key ->
  // still unendorsed. It is alone in ITS OWN tracking group (T-2), so the
  // legacy fallback keeps it -- a lone link is never dropped, endorsed or not.
  const other = { id: 70, reservationId: 33, trackingNumber: 'T-2', reservationTracking: 'SOME-OTHER' };
  assert.deepEqual(ids(selectCanonicalBfmrLinks([small, other])), [50, 70], 'different tracking numbers never collide');

  // Mismatched reservationTracking inside a REAL collision is not an
  // endorsement: it must not promote both links, so smallest id still wins.
  const wrongEndorse = { id: 80, reservationId: 44, trackingNumber: 'T-1', reservationTracking: 'SOME-OTHER' };
  assert.deepEqual(ids(selectCanonicalBfmrLinks([small, wrongEndorse])), [50], 'mismatched reservationTracking is not an endorsement');
});

test('collapses duplicate links on the same reservation within a group to the smallest id', () => {
  const dupBig = { id: 12, reservationId: 7, trackingNumber: 'T-3', reservationTracking: 'T-3' };
  const dupSmall = { id: 9, reservationId: 7, trackingNumber: 't-3', reservationTracking: 'T-3' };
  const out = selectCanonicalBfmrLinks([dupBig, dupSmall]);
  assert.deepEqual(ids(out), [9], 'same reservation + same tracking -> one link, smallest id');
});

test('step-1 parent-drop unchanged; untracked links pass through', () => {
  // Reservation 40 was split: tracked child supersedes the no-tracking parent.
  const parent = { id: 300, reservationId: 40, trackingNumber: null };
  const child = { id: 301, reservationId: 40, trackingNumber: 'T-9', reservationTracking: 'T-9' };
  // Reservation 41 was never split: its untracked link must survive.
  const soloUntracked = { id: 302, reservationId: 41, trackingNumber: '' };
  const out = selectCanonicalBfmrLinks([parent, child, soloUntracked]);
  assert.deepEqual(ids(out), [301, 302], 'split parent dropped; un-split untracked link kept');
});

test('returns a subset with same identities and input order; never mutates input', () => {
  const a = { id: 1, reservationId: 1, trackingNumber: 'T-A', reservationTracking: 'T-A' };
  const b = { id: 2, reservationId: 2, trackingNumber: 'T-B', reservationTracking: null };
  const c = { id: 3, reservationId: 3, trackingNumber: 't-b', reservationTracking: 'T-B' };
  const input = [a, b, c];
  const snapshot = JSON.stringify(input);
  const out = selectCanonicalBfmrLinks(input);
  assert.deepEqual(JSON.stringify(input), snapshot, 'input must not be mutated');
  assert.ok(out.every((l) => input.includes(l)), 'output must reuse the same object identities');
  assert.deepEqual(ids(out), [1, 3], 'endorsed links kept in input order; unendorsed b dropped');
});
