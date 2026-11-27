import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCarrierPage, CARRIER_STATUS_WORDS, hasCarrierStatusWord } from './carrierPage.ts';

// All page text below is made up.
const NOW = new Date('2026-11-26T12:00:00Z');
const iso = (t: string) => parseCarrierPage(t, NOW).deliveredAt?.toISOString();

test('delivered with a numeric date and a 12-hour time', () => {
  const r = parseCarrierPage('Tracking ID 000000000000\nDelivered\nTuesday, 11/24/26 at 2:15 PM\nSigned for by: F.DOOR', NOW);
  assert.equal(r.status, 'delivered');
  assert.equal(r.deliveredAt?.toISOString(), '2026-11-24T14:15:00.000Z');
});

test('delivered on one line with a month name and no year', () => {
  assert.equal(iso('Delivered On Friday, November 20 at 1:07 P.M.'), '2026-11-20T13:07:00.000Z');
  assert.equal(iso('Delivered Nov 20 at 12:05 AM'), '2026-11-20T00:05:00.000Z');
});

test('delivered with a full month name, year and 24-hour time', () => {
  assert.equal(iso('Delivered Monday, November 23, 2026 14:30'), '2026-11-23T14:30:00.000Z');
  assert.equal(iso('Delivered 2026-11-22 09:10'), '2026-11-22T09:10:00.000Z');
  assert.equal(iso('Delivered 22 November 2026'), '2026-11-22T12:00:00.000Z');
});

test('a yearless date after the new year points at last year', () => {
  assert.equal(parseCarrierPage('Delivered December 30 at 3:00 PM', new Date('2027-01-02T00:00:00Z')).deliveredAt?.toISOString(), '2026-12-30T15:00:00.000Z');
});

test('a date with no time keeps its day', () => {
  assert.equal(iso('Delivered\n11/24/2026'), '2026-11-24T12:00:00.000Z');
});

test('a bare Delivered step label is not a delivery', () => {
  const t = 'Label created\nShipped\nOut for delivery\nDelivered\n';
  assert.deepEqual(parseCarrierPage(t, NOW), { status: 'in_transit' });
  assert.equal(parseCarrierPage('Delivered', NOW).status, 'unknown');
});

test('estimated and not-yet wording is not a delivery', () => {
  assert.equal(parseCarrierPage('Estimated delivery\nFriday, 11/27/26 by 8:00 PM\nIn transit', NOW).status, 'in_transit');
  assert.equal(parseCarrierPage('Delivered\nEstimated delivery 11/27/26', NOW).status, 'unknown');
  assert.equal(parseCarrierPage('Not delivered yet 11/24/26', NOW).status, 'unknown');
});

test('exception and in-transit pages', () => {
  assert.equal(parseCarrierPage('Delivery exception\nUnable to deliver, recipient not available\n11/24/26', NOW).status, 'exception');
  assert.equal(parseCarrierPage('In transit\nArrived at facility, Springfield', NOW).status, 'in_transit');
  assert.equal(parseCarrierPage('Out for delivery', NOW).status, 'in_transit');
});

test('empty or unrelated text is unknown', () => {
  assert.deepEqual(parseCarrierPage('', NOW), { status: 'unknown' });
  assert.deepEqual(parseCarrierPage('Enter a tracking number', NOW), { status: 'unknown' });
});

test('an impossible date is ignored', () => {
  assert.equal(parseCarrierPage('Delivered 13/45/2026', NOW).status, 'unknown');
});

test('the common page shapes', () => {
  assert.equal(iso('Delivered Monday, 11/23/26 at 2:14 PM'), '2026-11-23T14:14:00.000Z');
  assert.equal(iso('Delivered On Monday, November 23 at 2:14 P.M.'), '2026-11-23T14:14:00.000Z');
  assert.equal(iso('DELIVERED 11/23/2026'), '2026-11-23T12:00:00.000Z');
  assert.equal(iso('Delivered Monday, 11/23 at 9:05 AM'), '2026-11-23T09:05:00.000Z');
});

test('no clear date means no delivered date', () => {
  // Relative words and a day-first date cannot be read safely.
  assert.equal(parseCarrierPage('Delivered Today at 2:14 PM', NOW).deliveredAt, undefined);
  assert.equal(parseCarrierPage('Delivered 23/11/2026', NOW).status, 'unknown');
  // A delivery in the future was misread.
  assert.equal(parseCarrierPage('Delivered 12/30/2026', NOW).status, 'unknown');
  assert.equal(parseCarrierPage('Delivered 11/23/1999', NOW).status, 'unknown');
});

test('status words are shared and found case-insensitively', () => {
  assert.ok(CARRIER_STATUS_WORDS.includes('delivered'));
  assert.ok(CARRIER_STATUS_WORDS.includes('in transit'));
  assert.equal(hasCarrierStatusWord('Loading... DELIVERED'), true);
  assert.equal(hasCarrierStatusWord('Out For Delivery'), true);
  assert.equal(hasCarrierStatusWord('Enter a tracking number'), false);
  assert.equal(hasCarrierStatusWord(''), false);
});
