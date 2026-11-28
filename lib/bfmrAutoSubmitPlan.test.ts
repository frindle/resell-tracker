/**
 * Planning for BFMR tracking auto-submit. All data is made up.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { PackageDecision } from './bfmrPackageMatch.ts';
import {
  planAutoSubmit, parseAutoSubmitMode, replayVerdict, withoutOwnSubmission,
  type OrderFacts, type ReservationFacts,
} from './bfmrAutoSubmitPlan.ts';
import { findMissingBfmrId } from './bfmrSubmitFlow.ts';

const exact = (orderId: number, tracking: string, allocations: { reservationId: number; qty: number }[]): PackageDecision =>
  ({ decision: 'exact', orderId, orderNumber: `O${orderId}`, trackingNumber: tracking, allocations, message: 'ok', caveats: [] });
const manual = (orderId: number, tracking: string, reason: 'item_unmatched' | 'already_submitted' | 'quantity_over' = 'item_unmatched'): PackageDecision =>
  ({ decision: 'manual', orderId, orderNumber: `O${orderId}`, trackingNumber: tracking, reason, message: 'no', allocations: [], caveats: [] });

const okOrder: OrderFacts = { locked: false, cancelled: false, hasRejectedItems: false };
const orders = (over: Partial<OrderFacts> = {}) => new Map<number, OrderFacts>([[1, { ...okOrder, ...over }], [2, okOrder]]);
const okRes = (over: Partial<ReservationFacts> = {}): ReservationFacts =>
  ({ bfmrOrderId: 'B1', myTrackerId: 5, status: 'purchased', submittedTrackings: [], ...over });
const reservations = (m: Record<number, Partial<ReservationFacts>>) => new Map(Object.entries(m).map(([k, v]) => [Number(k), okRes(v)]));

test('mode: off / plan / on, anything else (and unset) is plan', () => {
  assert.equal(parseAutoSubmitMode('off'), 'off');
  assert.equal(parseAutoSubmitMode(' ON '), 'on');
  assert.equal(parseAutoSubmitMode('plan'), 'plan');
  assert.equal(parseAutoSubmitMode(undefined), 'plan');
  assert.equal(parseAutoSubmitMode('yes'), 'plan');
});

test('a whole order in one package: one reservation, one row', () => {
  const p = planAutoSubmit([exact(1, 'TRK00000001', [{ reservationId: 10, qty: 4 }])], orders(), reservations({ 10: {} }));
  assert.deepEqual(p.submits, [{ orderId: 1, reservationId: 10, rows: [{ qty: 4, trackingNumber: 'TRK00000001' }] }]);
  assert.deepEqual(p.skips, []);
});

test('a qty-4 order split 2+2 over two packages is ONE call per reservation with TWO rows', () => {
  const p = planAutoSubmit(
    [exact(1, 'TRK00000001', [{ reservationId: 10, qty: 2 }]), exact(1, 'TRK00000002', [{ reservationId: 10, qty: 2 }])],
    orders(), reservations({ 10: {} }));
  assert.equal(p.submits.length, 1);
  assert.deepEqual(p.submits[0].rows, [{ qty: 2, trackingNumber: 'TRK00000001' }, { qty: 2, trackingNumber: 'TRK00000002' }]);
});

test('only the first of two boxes captured: it goes out alone (the rest waits for its box)', () => {
  const p = planAutoSubmit([exact(1, 'TRK00000001', [{ reservationId: 10, qty: 2 }])], orders(), reservations({ 10: {} }));
  assert.deepEqual(p.submits[0].rows, [{ qty: 2, trackingNumber: 'TRK00000001' }]);
});

test('second box later: the first box is already recorded, only the new one goes', () => {
  const p = planAutoSubmit(
    [manual(1, 'TRK00000001', 'already_submitted'), exact(1, 'TRK00000002', [{ reservationId: 10, qty: 2 }])],
    orders(), reservations({ 10: { submittedTrackings: ['trk00000001'] } }));
  assert.deepEqual(p.submits[0].rows, [{ qty: 2, trackingNumber: 'TRK00000002' }]);
});

test('a manual package never blocks an exact package of the same order', () => {
  const p = planAutoSubmit([manual(1, 'TRK00000001'), exact(1, 'TRK00000002', [{ reservationId: 10, qty: 2 }])], orders(), reservations({ 10: {} }));
  assert.equal(p.submits.length, 1);
  assert.equal(p.skips.length, 1);
  assert.match(p.skips[0].reason, /needs a human/);
});

test('skip: locked, cancelled, rejected items', () => {
  const d = [exact(1, 'TRK00000001', [{ reservationId: 10, qty: 1 }])];
  for (const [o, re] of [[{ locked: true }, /locked/], [{ cancelled: true }, /cancelled/], [{ hasRejectedItems: true }, /rejected/]] as const) {
    const p = planAutoSubmit(d, orders(o), reservations({ 10: {} }));
    assert.equal(p.submits.length, 0);
    assert.match(p.skips[0].reason, re);
  }
});

test('skip: reservation missing bfmrOrderId or myTrackerId, wrong status, tracking already recorded', () => {
  const d = [exact(1, 'TRK00000001', [{ reservationId: 10, qty: 1 }])];
  const cases: [Partial<ReservationFacts>, RegExp][] = [
    [{ bfmrOrderId: null }, /no bfmrOrderId/],
    [{ myTrackerId: null }, /no myTrackerId/],
    [{ status: 'received' }, /status/],
    [{ submittedTrackings: ['TRK00000001'] }, /already recorded/],
  ];
  for (const [r, re] of cases) {
    const p = planAutoSubmit(d, orders(), reservations({ 10: r }));
    assert.equal(p.submits.length, 0);
    assert.match(p.skips[0].reason, re);
  }
  assert.equal(planAutoSubmit(d, orders(), reservations({ 10: { status: 'shipped' } })).submits.length, 1);
  assert.equal(planAutoSubmit(d, orders(), new Map()).submits.length, 0);
});

test('a package split over two reservations is all-or-nothing', () => {
  const d = [exact(1, 'TRK00000001', [{ reservationId: 10, qty: 1 }, { reservationId: 11, qty: 1 }])];
  const p = planAutoSubmit(d, orders(), reservations({ 10: {}, 11: { myTrackerId: null } }));
  assert.equal(p.submits.length, 0);
});

test('runaway cap: more than 5 reservations in one run sends nothing', () => {
  const d = [1, 2, 3, 4, 5, 6].map(n => exact(n <= 2 ? n : 2, `TRK0000000${n}`, [{ reservationId: 100 + n, qty: 1 }]));
  const rs: Record<number, Partial<ReservationFacts>> = {};
  for (let n = 1; n <= 6; n++) rs[100 + n] = {};
  const p = planAutoSubmit(d, orders(), reservations(rs));
  assert.equal(p.submits.length, 0);
  assert.equal(p.skips.length, 6);
  assert.match(p.skips[0].reason, /runaway cap/);
  const five = planAutoSubmit(d.slice(0, 5), orders(), reservations(rs));
  assert.equal(five.submits.length, 5);
});

test('findMissingBfmrId: bfmrOrderId first, then myTrackerId; 0 counts as present', () => {
  assert.equal(findMissingBfmrId({ bfmrOrderId: null, myTrackerId: 1 }), 'bfmrOrderId');
  assert.equal(findMissingBfmrId({ bfmrOrderId: 'B', myTrackerId: null }), 'myTrackerId');
  assert.equal(findMissingBfmrId({ bfmrOrderId: 'B', myTrackerId: 0 }), null);
});

test('replay verdict: same rows agree in any order, anything else disagrees, nothing on either side is no_data', () => {
  const a = { reservationId: 10, qty: 2, trackingNumber: 'TRK00000001' };
  const b = { reservationId: 10, qty: 2, trackingNumber: 'TRK00000002' };
  assert.equal(replayVerdict([a, b], [{ ...b, trackingNumber: 'trk00000002' }, a]), 'agree');
  assert.equal(replayVerdict([a], [a, b]), 'disagree');
  assert.equal(replayVerdict([a], []), 'disagree');
  assert.equal(replayVerdict([], [a]), 'disagree');
  assert.equal(replayVerdict([{ ...a, qty: 3 }], [a]), 'disagree');
  assert.equal(replayVerdict([], []), 'no_data');
});

test('withoutOwnSubmission drops only that tracking from the recorded shipments', () => {
  const line = {
    id: 10, reserveId: 'R', bfmrOrderId: 'O', itemName: 'x', dealTitle: null, qty: 4, status: 'shipped', trackingNumber: 'TRK00000001',
    submitted: [{ qty: 2, trackingNumber: 'TRK00000001' }, { qty: 2, trackingNumber: 'TRK00000002' }], links: [],
  };
  const [l] = withoutOwnSubmission([line], 'trk00000001');
  assert.deepEqual(l.submitted, [{ qty: 2, trackingNumber: 'TRK00000002' }]);
  assert.equal(l.trackingNumber, null);
  assert.equal(withoutOwnSubmission([line], 'TRK00000002')[0].trackingNumber, 'TRK00000001');
});
