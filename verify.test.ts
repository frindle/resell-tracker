// Adversarial fixture for: bfmrLinkReconcile-v2 (step 3: twin collapse)
//
// Every twin / split fixture sets reservationTracking === trackingNumber on BOTH links
// (endorsed): step 2 keeps both endorsed links, so step 3 is what must decide.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectCanonicalBfmrLinks, type BfmrLinkLike } from './lib/bfmrLinkReconcile.ts';

const ids = (links: BfmrLinkLike[]) => links.map((l) => l.id);
const run = (links: any[]) => ids(selectCanonicalBfmrLinks(links as BfmrLinkLike[]));

/** An ENDORSED link: the reservation row reports the same tracking as the link. */
const mk = (id: number, reservationId: number, tracking: string | null, extra: Record<string, unknown> = {}): any => ({
  id, reservationId, trackingNumber: tracking, reservationTracking: tracking, ...extra,
});

const T = '9339589725268581127361';

// ---- existing behaviour (steps 1 and 2) must NOT change -------------------------------
test('order 929: different reserveIds, same tracking, both endorsed -> BOTH kept', () => {
  const a = mk(188, 307956, T, { reserveId: 'R-A', quantity: 3 });
  const b = mk(189, 307955, T, { reserveId: 'R-B', quantity: 3 });
  assert.deepEqual(run([a, b]), [188, 189]);
});

test('order 929: no reserveId at all, both endorsed -> BOTH kept', () => {
  assert.deepEqual(run([mk(188, 307956, T), mk(189, 307955, T)]), [188, 189]);
});

test('order 906: unendorsed mislink loses to the endorsed sibling', () => {
  const stale = { id: 153, reservationId: 164353, trackingNumber: '1Z82AA931379787130', reservationTracking: null };
  const real = mk(190, 238161, '1Z82AA931379787130');
  assert.deepEqual(run([stale, real]), [190]);
});

test('order 767: links on a reservation owning a THIRD tracking lose to the owners', () => {
  const misA = { id: 104, reservationId: 6480, trackingNumber: 'A-1', reservationTracking: 'THIRD' };
  const misB = { id: 105, reservationId: 6480, trackingNumber: 'B-1', reservationTracking: 'THIRD' };
  assert.deepEqual(run([misA, mk(200, 216284, 'A-1'), misB, mk(201, 216283, 'B-1')]), [200, 201]);
});

test('step 2 legacy fallback: nobody endorsed -> smallest id, even if the other is a newer twin', () => {
  const big = { id: 60, reservationId: 22, trackingNumber: 'T-1', reserveId: 'R-1', quantity: 1, lastSyncedAt: '2026-10-10T00:00:00Z' };
  const small = { id: 50, reservationId: 11, trackingNumber: 't-1 ', reserveId: 'R-1', quantity: 1, lastSyncedAt: '2026-01-01T00:00:00Z' };
  assert.deepEqual(run([big, small]), [50]);
});

test('step 1 parent drop and untracked pass-through are unchanged', () => {
  const parent = { id: 300, reservationId: 40, trackingNumber: null };
  const child = mk(301, 40, 'T-9');
  const solo = { id: 302, reservationId: 41, trackingNumber: '' };
  assert.deepEqual(run([parent, child, solo]), [301, 302]);
});

// ---- step 3: twins collapse ----------------------------------------------------------
test('twins (same reserveId + tracking + quantity, different reservationId): newest lastSyncedAt wins, either input order', () => {
  const older = mk(1, 100, 'TRACK-ONE', { reserveId: 'R-99', quantity: 3, lastSyncedAt: new Date('2026-05-01T00:00:00Z') });
  const newer = mk(2, 200, 'TRACK-ONE', { reserveId: 'R-99', quantity: 3, lastSyncedAt: new Date('2026-05-10T00:00:00Z') });
  assert.deepEqual(run([older, newer]), [2]);
  assert.deepEqual(run([newer, older]), [2]);
});

test('newest wins even when it has the LARGER id and the older twin has the smaller id', () => {
  const small = mk(5, 100, 'TW', { reserveId: 'R', quantity: 1, lastSyncedAt: '2026-05-01T00:00:00Z' });
  const big = mk(900, 200, 'TW', { reserveId: 'R', quantity: 1, lastSyncedAt: '2026-05-02T00:00:00Z' });
  assert.deepEqual(run([small, big]), [900]);
  assert.deepEqual(run([big, small]), [900]);
});

test('lastSyncedAt compares as time: ISO strings and Dates mix, timezone offsets honoured', () => {
  const asString = mk(1, 100, 'TZ', { reserveId: 'R', quantity: 1, lastSyncedAt: '2026-05-10T12:00:00+02:00' }); // 10:00Z
  const asDate = mk(2, 200, 'TZ', { reserveId: 'R', quantity: 1, lastSyncedAt: new Date('2026-05-10T11:00:00Z') });
  assert.deepEqual(run([asString, asDate]), [2]);
  assert.deepEqual(run([asDate, asString]), [2]);
  // a lexicographically-later string that is EARLIER in time must lose
  const early = mk(3, 300, 'TZ2', { reserveId: 'R2', quantity: 1, lastSyncedAt: '2026-05-10T23:00:00-12:00' }); // 11th 11:00Z
  const late = mk(4, 400, 'TZ2', { reserveId: 'R2', quantity: 1, lastSyncedAt: '2026-05-11T01:00:00Z' });
  assert.deepEqual(run([late, early]), [3], 'string order is not time order');
});

test('tie on lastSyncedAt -> smallest id, either input order', () => {
  const a = mk(50, 1, 'T', { reserveId: 'R-1', quantity: 2, lastSyncedAt: new Date('2026-06-01') });
  const b = mk(49, 2, 't', { reserveId: 'R-1', quantity: 2, lastSyncedAt: new Date('2026-06-01') });
  assert.deepEqual(run([a, b]), [49]);
  assert.deepEqual(run([b, a]), [49]);
});

test('all lastSyncedAt missing (undefined / null / invalid) -> smallest id, either input order', () => {
  for (const missing of [undefined, null, 'not-a-date', '', new Date('nope')]) {
    const a = mk(70, 1, 'M', { reserveId: 'R-M', quantity: 1, lastSyncedAt: missing });
    const b = mk(60, 2, 'M', { reserveId: 'R-M', quantity: 1, lastSyncedAt: missing });
    assert.deepEqual(run([a, b]), [60], 'missing=' + String(missing));
    assert.deepEqual(run([b, a]), [60], 'missing=' + String(missing));
  }
});

test('a missing / invalid lastSyncedAt ranks OLDEST: the dated twin wins even with the larger id', () => {
  for (const missing of [undefined, null, 'garbage', new Date('nope')]) {
    const undated = mk(10, 30, 'X', { reserveId: 'R-X', quantity: 1, lastSyncedAt: missing });
    const dated = mk(20, 40, 'X', { reserveId: 'R-X', quantity: 1, lastSyncedAt: '1999-01-01T00:00:00Z' });
    assert.deepEqual(run([undated, dated]), [20], 'missing=' + String(missing));
    assert.deepEqual(run([dated, undated]), [20], 'missing=' + String(missing));
  }
});

test('epoch-zero lastSyncedAt is a real date and beats a missing one', () => {
  const missing = mk(1, 30, 'E', { reserveId: 'R-E', quantity: 1 });
  const epoch = mk(2, 40, 'E', { reserveId: 'R-E', quantity: 1, lastSyncedAt: new Date(0) });
  assert.deepEqual(run([missing, epoch]), [2]);
});

test('three twins -> exactly one survivor, the newest', () => {
  const o = mk(1, 701, 'TRIPLE', { reserveId: 'R-T', quantity: 2, lastSyncedAt: new Date('2026-03-01') });
  const m = mk(5, 702, 'Triple', { reserveId: 'R-T', quantity: 2, lastSyncedAt: new Date('2026-04-15') });
  const n = mk(3, 703, 'triple', { reserveId: 'R-T', quantity: 2, lastSyncedAt: new Date('2026-05-15') });
  assert.deepEqual(run([o, m, n]), [3]);
  assert.deepEqual(run([n, m, o]), [3]);
});

test('reserveId and tracking compare NORMALIZED (trim + case-insensitive)', () => {
  const a = mk(1, 100, ' abc-1 ', { reserveId: 'R-Q', quantity: 1, lastSyncedAt: '2026-01-01T00:00:00Z' });
  const b = mk(2, 200, 'ABC-1', { reserveId: '  r-q', quantity: 1, lastSyncedAt: '2026-02-01T00:00:00Z' });
  assert.deepEqual(run([a, b]), [2]);
});

test('null quantity and undefined quantity are the SAME key; 0 is a different key from null', () => {
  const qNull = mk(11, 31, 'Q', { reserveId: 'R-Q', quantity: null, lastSyncedAt: '2026-01-01T00:00:00Z' });
  const qUndef = mk(21, 41, 'Q', { reserveId: 'R-Q', lastSyncedAt: '2026-02-01T00:00:00Z' });
  assert.deepEqual(run([qNull, qUndef]), [21]);
  const qZero = mk(31, 51, 'Q', { reserveId: 'R-Q', quantity: 0, lastSyncedAt: '2026-03-01T00:00:00Z' });
  assert.deepEqual(run([qNull, qZero]), [11, 31]);
  assert.deepEqual(run([qZero, mk(32, 52, 'Q', { reserveId: 'R-Q', quantity: 0, lastSyncedAt: '2026-04-01T00:00:00Z' })]), [32]);
});

test('two independent twin pairs each collapse to their own newest, survivors keep input order', () => {
  const a1 = mk(1, 10, 'TA', { reserveId: 'RA', quantity: 1, lastSyncedAt: '2026-01-01T00:00:00Z' });
  const b1 = mk(2, 20, 'TB', { reserveId: 'RB', quantity: 1, lastSyncedAt: '2026-03-01T00:00:00Z' });
  const a2 = mk(3, 30, 'TA', { reserveId: 'RA', quantity: 1, lastSyncedAt: '2026-02-01T00:00:00Z' });
  const b2 = mk(4, 40, 'TB', { reserveId: 'RB', quantity: 1, lastSyncedAt: '2026-01-01T00:00:00Z' });
  const solo = mk(5, 50, 'TS');
  assert.deepEqual(run([a1, b1, a2, b2, solo]), [2, 3, 5]);
});

// ---- step 3: things that must still SUM ----------------------------------------------
test('real split: same reserveId, DIFFERENT tracking -> both kept', () => {
  const a = mk(50, 700, 'T-A', { reserveId: 'R-S', quantity: 2, lastSyncedAt: '2026-01-01T00:00:00Z' });
  const b = mk(60, 800, 'T-B', { reserveId: 'R-S', quantity: 2, lastSyncedAt: '2026-02-01T00:00:00Z' });
  assert.deepEqual(run([a, b]), [50, 60]);
});

test('real split: same reserveId + tracking, DIFFERENT quantity -> both kept', () => {
  const a = mk(70, 900, 'SPLIT', { reserveId: 'R-S', quantity: 2, lastSyncedAt: '2026-01-01T00:00:00Z' });
  const b = mk(80, 1000, 'split', { reserveId: 'R-S', quantity: 4, lastSyncedAt: '2026-02-01T00:00:00Z' });
  assert.deepEqual(run([a, b]), [70, 80]);
});

test('same tracking + quantity, DIFFERENT reserveId -> both kept', () => {
  const a = mk(1, 10, 'T', { reserveId: 'R-ONE', quantity: 3, lastSyncedAt: '2026-01-01T00:00:00Z' });
  const b = mk(2, 20, 'T', { reserveId: 'R-TWO', quantity: 3, lastSyncedAt: '2026-02-01T00:00:00Z' });
  assert.deepEqual(run([a, b]), [1, 2]);
});

test('no / empty / whitespace reserveId never groups (both endorsed, same tracking -> both kept)', () => {
  for (const reserveId of [undefined, null, '', '   ']) {
    const a = mk(1, 10, 'T', { reserveId, quantity: 1, lastSyncedAt: '2026-01-01T00:00:00Z' });
    const b = mk(2, 20, 'T', { reserveId, quantity: 1, lastSyncedAt: '2026-02-01T00:00:00Z' });
    assert.deepEqual(run([a, b]), [1, 2], 'reserveId=' + JSON.stringify(reserveId));
  }
});

test('a link with no tracking never groups: same reserveId, no tracking, different reservations -> both kept', () => {
  for (const tracking of [null, '', '  ']) {
    const a = { id: 1, reservationId: 10, trackingNumber: tracking, reserveId: 'R-Z', quantity: 1, lastSyncedAt: '2026-01-01T00:00:00Z' };
    const b = { id: 2, reservationId: 20, trackingNumber: tracking, reserveId: 'R-Z', quantity: 1, lastSyncedAt: '2026-02-01T00:00:00Z' };
    assert.deepEqual(run([a, b]), [1, 2], 'tracking=' + JSON.stringify(tracking));
  }
});

test('twin pair beside an order-929 sibling (different reserveId, same tracking): twins collapse, sibling stays', () => {
  const t1 = mk(1, 10, 'T', { reserveId: 'R-ONE', quantity: 3, lastSyncedAt: '2026-01-01T00:00:00Z' });
  const t2 = mk(2, 20, 'T', { reserveId: 'R-ONE', quantity: 3, lastSyncedAt: '2026-02-01T00:00:00Z' });
  const sib = mk(3, 30, 'T', { reserveId: 'R-TWO', quantity: 3, lastSyncedAt: '2026-01-01T00:00:00Z' });
  assert.deepEqual(run([t1, t2, sib]), [2, 3]);
});

// ---- step 3 runs on what step 2 KEPT --------------------------------------------------
test('step 3 only sees step-2 survivors: an unendorsed newer twin dropped by step 2 cannot win', () => {
  const unendorsed = { id: 1, reservationId: 10, trackingNumber: 'T', reservationTracking: null, reserveId: 'R', quantity: 1, lastSyncedAt: '2026-12-01T00:00:00Z' };
  const endorsed = mk(2, 20, 'T', { reserveId: 'R', quantity: 1, lastSyncedAt: '2026-01-01T00:00:00Z' });
  assert.deepEqual(run([unendorsed, endorsed]), [2]);
  assert.deepEqual(run([endorsed, unendorsed]), [2]);
});

test('step 2 same-reservationId collapse is unchanged: one reservation, two links -> smallest id', () => {
  const a = mk(9, 10, 'T', { reserveId: 'R', quantity: 1 });
  const b = mk(8, 10, 'T', { reserveId: 'R', quantity: 1 });
  assert.deepEqual(run([a, b]), [8]);
});

// ---- shape ---------------------------------------------------------------------------
test('returns the SAME objects, in input order, and does not mutate the input', () => {
  const s = mk(30, 780, 'S');
  const t1 = mk(40, 790, 'TW', { reserveId: 'R-TW', quantity: 3, lastSyncedAt: '2026-05-01T00:00:00Z' });
  const t2 = mk(45, 800, 'tw', { reserveId: 'R-TW', quantity: 3, lastSyncedAt: '2026-05-10T00:00:00Z' });
  const z = mk(99, 810, 'Z');
  const input = [s, t1, t2, z];
  const out = selectCanonicalBfmrLinks(input as BfmrLinkLike[]);
  assert.equal(out.length, 3);
  assert.equal(out[0], s);
  assert.equal(out[1], t2);
  assert.equal(out[2], z);
  assert.equal(input.length, 4);
  assert.deepEqual(input, [s, t1, t2, z]);
});

test('empty input and a lone fully-populated link', () => {
  assert.deepEqual(run([]), []);
  assert.deepEqual(run([mk(100, 860, 'S', { reserveId: 'R-SOLO', quantity: 5, lastSyncedAt: '2026-09-01T00:00:00Z' })]), [100]);
});
