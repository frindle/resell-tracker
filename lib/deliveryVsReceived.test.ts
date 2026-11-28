import test from 'node:test';
import assert from 'node:assert/strict';
import { expectedOf, deliveryVsReceived, summarizeDelivery, deliveryLine, deliveryDisplay, receivedLabel, showNotReceived, groupFor, groupReceiptFor, LATE_RECEIPT_DAYS, type DeliveryRow, type GroupReceipt } from './deliveryVsReceived.ts';

const NOW = new Date('2026-11-28T15:00:00Z');
const row = (n: string, extra: Partial<DeliveryRow> = {}): DeliveryRow =>
  ({ trackingNumber: n, carrier: 'ups', status: 'delivered', deliveredAt: new Date('2026-11-25T14:00:00Z'), source: 'carrier-page', ...extra });
const notYet: GroupReceipt = { state: 'not_yet', group: 'BFMR' };
const got: GroupReceipt = { state: 'received', group: 'BG', at: new Date('2026-11-26T09:00:00Z') };

test('one delivered package', () => {
  const v = deliveryVsReceived({ trackingNumbers: ['1Z1'], rows: [row('1Z1')], received: got, now: NOW });
  assert.equal(v.delivered.state, 'delivered');
  assert.equal(deliveryLine(v), 'Delivered Nov 25 (UPS) · Received by BG Nov 26');
  assert.equal(v.lateReceipt, false);
});

test('delivered but the group has not received it: flagged after the threshold, with day count', () => {
  assert.equal(LATE_RECEIPT_DAYS, 3);
  const v = deliveryVsReceived({ trackingNumbers: ['1Z1'], rows: [row('1Z1')], received: notYet, now: NOW });
  assert.equal(v.daysSinceDelivered, 3);
  assert.equal(v.lateReceipt, true);
  assert.equal(deliveryLine(v), 'Delivered Nov 25 (UPS) · Not received by BFMR yet (3 days)');
});

test('not flagged inside the window or when the group receipt is unknown', () => {
  const recent = deliveryVsReceived({ trackingNumbers: ['1Z1'], rows: [row('1Z1', { deliveredAt: new Date('2026-11-27T10:00:00Z') })], received: notYet, now: NOW });
  assert.equal(recent.lateReceipt, false);
  const unknown = deliveryVsReceived({ trackingNumbers: ['1Z1'], rows: [row('1Z1')], received: { state: 'unknown' }, now: NOW });
  assert.equal(unknown.lateReceipt, false);
});

test('several packages: delivered only when all are', () => {
  const rows = [row('A'), row('B', { status: 'in_transit', deliveredAt: null })];
  const d = summarizeDelivery(['A', 'B'], rows);
  assert.deepEqual([d.state, (d as { delivered: number }).delivered, (d as { total: number }).total], ['partial', 1, 2]);
  const v = deliveryVsReceived({ trackingNumbers: ['A', 'B'], rows, received: notYet, now: NOW });
  assert.equal(v.lateReceipt, false);
  assert.match(deliveryLine(v) ?? '', /^1 of 2 delivered/);
  assert.equal(summarizeDelivery(['A', 'B'], [row('A'), row('B')]).state, 'delivered');
});

test('uses the latest delivery for the carrier and matches numbers loosely', () => {
  const d = summarizeDelivery([' a b ', 'C'], [row('AB'), row('C', { carrier: 'fedex', deliveredAt: new Date('2026-11-27T08:00:00Z') })]);
  assert.equal(d.state, 'delivered');
  assert.equal((d as { carrier: string }).carrier, 'fedex');
});

test('no delivered rows: exception beats in transit; no rows is unknown', () => {
  assert.equal(summarizeDelivery(['A', 'B'], [row('A', { status: 'in_transit', deliveredAt: null }), row('B', { status: 'exception', deliveredAt: null })]).state, 'exception');
  assert.equal(summarizeDelivery(['A'], [row('A', { status: 'in_transit', deliveredAt: null })]).state, 'in_transit');
  assert.equal(summarizeDelivery(['A'], []).state, 'unknown');
  assert.equal(summarizeDelivery([], [row('A')]).state, 'unknown');
});

test('received without a date, and a line only when something is known', () => {
  const v = deliveryVsReceived({ trackingNumbers: ['X'], rows: [row('X')], received: { state: 'received', group: 'BFMR', at: null }, now: NOW });
  assert.equal(deliveryLine(v), 'Delivered Nov 25 (UPS) · Received by BFMR');
  const none = deliveryVsReceived({ trackingNumbers: [], rows: [], received: { state: 'unknown' }, now: NOW });
  assert.equal(deliveryLine(none), null);
});

test('group choice: buyer name first, then links', () => {
  assert.equal(groupFor({ buyerName: 'BFMR', hasBgLink: true }), 'BFMR');
  assert.equal(groupFor({ buyerName: 'Buying Group' }), 'BG');
  assert.equal(groupFor({ buyerName: 'Big Sky Buyers' }), 'BigSky');
  assert.equal(groupFor({ hasBigSkyLink: true }), 'BigSky');
  assert.equal(groupFor({ buyerName: 'Someone' }), null);
});

test('BFMR receipt comes from the flag or status, no date', () => {
  assert.deepEqual(groupReceiptFor('BFMR', { bfmrReceived: true }), { state: 'received', group: 'BFMR', at: null });
  assert.equal(groupReceiptFor('BFMR', { bfmrStatus: 'pkg_received' }).state, 'received');
  assert.equal(groupReceiptFor('BFMR', { bfmrStatus: 'shipped', reservationStatuses: ['shipped'] }).state, 'not_yet');
  assert.equal(groupReceiptFor('BFMR', { reservationStatuses: ['received', 'paid'] }).state, 'received');
});

test('BG receipt is commitment level; partial fills are unknown', () => {
  const at = new Date('2026-11-26T00:00:00Z');
  assert.deepEqual(groupReceiptFor('BG', { commitments: [{ fulfilled: 2, count: 2, fulfilledAt: at }] }), { state: 'received', group: 'BG', at });
  assert.equal(groupReceiptFor('BG', { commitments: [{ fulfilled: 0, count: 2, fulfilledAt: null }] }).state, 'not_yet');
  assert.equal(groupReceiptFor('BG', { commitments: [{ fulfilled: 1, count: 2, fulfilledAt: null }] }).state, 'unknown');
  assert.equal(groupReceiptFor('BG', {}).state, 'unknown');
});

test('BigSky receipt comes from a scan naming the order', () => {
  const d = new Date('2026-11-26T00:00:00Z');
  assert.deepEqual(groupReceiptFor('BigSky', { bigSkyScanDates: [d] }), { state: 'received', group: 'BigSky', at: d });
  assert.equal(groupReceiptFor('BigSky', { bigSkyScanDates: [] }).state, 'not_yet');
  assert.equal(groupReceiptFor(null, {}).state, 'unknown');
});

test('an order no group is waiting on shows only the carrier side', () => {
  const none = deliveryVsReceived({ trackingNumbers: ['1Z1'], rows: [row('1Z1')], received: { state: 'unknown' }, now: NOW });
  assert.equal(deliveryLine(none), 'Delivered Nov 25 (UPS)');
  assert.equal(deliveryDisplay(none)?.received, null);
  const bgUnknown = deliveryVsReceived({ trackingNumbers: ['1Z1'], rows: [row('1Z1')], received: { state: 'unknown', group: 'BG' }, now: NOW });
  assert.equal(deliveryLine(bgUnknown), 'Delivered Nov 25 (UPS) · BG receipt unknown');
});

test('"Not received" shows only when the carrier says delivered', () => {
  const inTransit = row('A', { status: 'in_transit', deliveredAt: null });
  const cases: [string, DeliveryRow[], boolean][] = [
    ['delivered', [row('A')], true],
    ['in transit', [inTransit], false],
    ['exception', [row('A', { status: 'exception', deliveredAt: null })], false],
    ['delivery unknown', [], false],
  ];
  for (const [name, rows, shown] of cases) {
    const v = deliveryVsReceived({ trackingNumbers: ['A'], rows, received: notYet, now: NOW });
    assert.equal(receivedLabel(v) != null, shown, name);
    assert.equal(showNotReceived(v), shown, name);
    assert.equal(deliveryDisplay(v)?.received != null, shown, name);
  }
  const none = deliveryVsReceived({ trackingNumbers: [], rows: [], received: notYet, now: NOW });
  assert.equal(receivedLabel(none), null);
  assert.equal(deliveryLine(none), 'Delivery unknown');
  const part = deliveryVsReceived({ trackingNumbers: ['A', 'B'], rows: [row('A'), row('B', { status: 'in_transit', deliveredAt: null })], received: notYet, now: NOW });
  assert.equal(receivedLabel(part), null);
  // A group receipt is still shown whatever the carrier says.
  const got2 = deliveryVsReceived({ trackingNumbers: ['A'], rows: [], received: got, now: NOW });
  assert.equal(receivedLabel(got2), 'Received by BG Nov 26');
});

test('short labels for the table cell', () => {
  const v = deliveryVsReceived({ trackingNumbers: ['A'], rows: [row('A')], received: notYet, now: NOW });
  const d = deliveryDisplay(v);
  assert.equal(d?.deliveredShort, 'Delivered 11/25');
  assert.equal(d?.receivedShort, 'Not received (3d)');
  const r = deliveryDisplay(deliveryVsReceived({ trackingNumbers: ['A'], rows: [row('A')], received: got, now: NOW }));
  assert.equal(r?.receivedShort, 'Received 11/26');
});

test('a delivered date before the order or in the future does not count as delivered', () => {
  const ordered = new Date('2026-11-25T16:00:00Z');
  const run = (deliveredAt: Date) => deliveryVsReceived({
    trackingNumbers: ['A'], rows: [row('A', { deliveredAt })], received: notYet, now: NOW, orderDate: ordered,
  });
  const past = run(new Date('2025-12-11T12:00:00Z'));
  assert.equal(past.delivered.state, 'unknown');
  assert.equal(past.daysSinceDelivered, null);
  assert.equal(past.lateReceipt, false);
  assert.equal(showNotReceived(past), false);
  assert.equal(run(new Date('2026-12-11T12:00:00Z')).delivered.state, 'unknown');
  assert.equal(run(new Date('2026-11-26T12:00:00Z')).delivered.state, 'delivered');
});

// --- the merchant's expected delivery, only when there is no carrier status ---
const exp = (start: string, end = start, extra = {}) => expectedOf({ expectedDeliveryStart: new Date(`${start}T00:00:00Z`), expectedDeliveryEnd: new Date(`${end}T00:00:00Z`), expectedDeliverySource: 'amazon-page', expectedDeliverySeenAt: new Date('2026-11-27T18:00:00Z'), ...extra });

test('expected delivery stands in for "Delivery unknown" and for no delivery data at all', () => {
  const v = deliveryVsReceived({ trackingNumbers: ['1Z1'], rows: [], received: { state: 'unknown' }, now: NOW });
  assert.equal(deliveryDisplay(v)?.deliveredShort, undefined);
  const d = deliveryDisplay(v, exp('2026-11-30'), NOW);
  assert.deepEqual([d?.deliveredShort, d?.expected?.late], ['Arriving Nov 30', false]);
  assert.match(d?.expected?.tooltip ?? '', /Amazon page, seen Nov 27/);
  const none = deliveryDisplay(null, exp('2026-11-28', '2026-12-02'), NOW);
  assert.equal(none?.deliveredShort, 'Expected Nov 28\u2013Dec 2');
  const late = deliveryDisplay(null, exp('2026-11-25'), NOW);
  assert.deepEqual([late?.deliveredShort, late?.expected?.late], ['Late \u00b7 expected Nov 25', true]);
});

test('a carrier status or a delivery always wins over the expected date', () => {
  const e = exp('2026-11-30');
  const transit = deliveryVsReceived({ trackingNumbers: ['1Z1'], rows: [row('1Z1', { status: 'in_transit', deliveredAt: null })], received: { state: 'unknown' }, now: NOW });
  assert.equal(deliveryDisplay(transit, e, NOW)?.deliveredShort, 'In transit');
  assert.equal(deliveryDisplay(transit, e, NOW)?.expected, undefined);
  const delivered = deliveryVsReceived({ trackingNumbers: ['1Z1'], rows: [row('1Z1')], received: notYet, now: NOW });
  assert.equal(deliveryDisplay(delivered, exp('2026-11-20'), NOW)?.deliveredShort, 'Delivered 11/25');
  const exception = deliveryVsReceived({ trackingNumbers: ['1Z1'], rows: [row('1Z1', { status: 'exception', deliveredAt: null })], received: { state: 'unknown' }, now: NOW });
  assert.equal(deliveryDisplay(exception, e, NOW)?.deliveredShort, 'Delivery problem');
  // The group already has it: nothing left to expect.
  const got2 = deliveryVsReceived({ trackingNumbers: [], rows: [], received: got, now: NOW });
  assert.equal(deliveryDisplay(got2, e, NOW)?.expected, undefined);
});

test('expectedOf: nothing for a cancelled order, a missing date or a bad one', () => {
  assert.equal(exp('2026-11-30', '2026-11-30', { cancelled: true }), null);
  assert.equal(expectedOf({}), null);
  assert.equal(expectedOf({ expectedDeliveryStart: 'junk', expectedDeliveryEnd: 'junk' }), null);
});
