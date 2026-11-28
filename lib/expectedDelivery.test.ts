import test from 'node:test';
import assert from 'node:assert/strict';
import { parseExpectedDelivery, decideExpected, expectedDisplay, expectedRangeText } from './expectedDelivery.ts';

// All fixtures are synthetic. SEEN is Friday 2026-11-20, midday Pacific.
const SEEN = new Date('2026-11-20T20:00:00Z');
const day = (s: string) => new Date(`${s}T00:00:00Z`);
const iso = (r: { start: Date; end: Date } | null) => r && [r.start.toISOString().slice(0, 10), r.end.toISOString().slice(0, 10)];

test('a single day: "Arriving Nov 30", "Now expected Dec 2", "Arrives by Fri, Nov 28"', () => {
  assert.deepEqual(iso(parseExpectedDelivery('Arriving Nov 30', SEEN)), ['2026-11-30', '2026-11-30']);
  assert.deepEqual(iso(parseExpectedDelivery('Now expected Dec 2', SEEN)), ['2026-12-02', '2026-12-02']);
  assert.deepEqual(iso(parseExpectedDelivery('Arrives by Fri, Nov 28', SEEN)), ['2026-11-28', '2026-11-28']);
  assert.deepEqual(iso(parseExpectedDelivery('Item is now arriving Fri, Nov 27\nthanks', SEEN)), ['2026-11-27', '2026-11-27']);
  assert.deepEqual(iso(parseExpectedDelivery('Estimated delivery: Friday, 11/27/2026', SEEN)), ['2026-11-27', '2026-11-27']);
});

test('relative words are read against when the text was seen', () => {
  assert.deepEqual(iso(parseExpectedDelivery('Arriving tomorrow', SEEN)), ['2026-11-21', '2026-11-21']);
  assert.deepEqual(iso(parseExpectedDelivery('Arriving today', SEEN)), ['2026-11-20', '2026-11-20']);
  assert.deepEqual(iso(parseExpectedDelivery('Arriving Tuesday', SEEN)), ['2026-11-24', '2026-11-24']);
  assert.deepEqual(iso(parseExpectedDelivery('Arriving Friday', SEEN)), ['2026-11-20', '2026-11-20']);
  // The same text seen a week earlier means a different day.
  assert.deepEqual(iso(parseExpectedDelivery('Arriving tomorrow', new Date('2026-11-13T20:00:00Z'))), ['2026-11-14', '2026-11-14']);
  // Seen late in the evening Pacific (already the next day in UTC) is still that Pacific day.
  assert.deepEqual(iso(parseExpectedDelivery('Arriving tomorrow', new Date('2026-11-21T03:30:00Z'))), ['2026-11-21', '2026-11-21']);
});

test('ranges: Nov 28 - Dec 2, Nov 28-30, Thursday - Saturday, across the new year', () => {
  assert.deepEqual(iso(parseExpectedDelivery('Expected Nov 28 - Dec 2', SEEN)), ['2026-11-28', '2026-12-02']);
  assert.deepEqual(iso(parseExpectedDelivery('Arriving Nov 28–30', SEEN)), ['2026-11-28', '2026-11-30']);
  assert.deepEqual(iso(parseExpectedDelivery('Arriving Thursday - Saturday', SEEN)), ['2026-11-26', '2026-11-28']);
  assert.deepEqual(iso(parseExpectedDelivery('Arriving Dec 28 - Jan 2', new Date('2026-12-20T20:00:00Z'))), ['2026-12-28', '2027-01-02']);
});

test('year: a day early in the next year, and a capture just after new year, resolve sensibly', () => {
  assert.deepEqual(iso(parseExpectedDelivery('Arriving Jan 3', new Date('2026-12-28T20:00:00Z'))), ['2027-01-03', '2027-01-03']);
  assert.deepEqual(iso(parseExpectedDelivery('Arriving Dec 30', new Date('2027-01-02T20:00:00Z'))), ['2026-12-30', '2026-12-30']);
});

test('several packages become one window; unrelated far dates do not', () => {
  assert.deepEqual(iso(parseExpectedDelivery('Arriving Tuesday\nsecond box Arriving Nov 27', SEEN)), ['2026-11-24', '2026-11-27']);
  assert.deepEqual(iso(parseExpectedDelivery('Arriving Nov 24 ... Arriving Jan 30', SEEN)), ['2026-11-24', '2026-11-24']);
});

test('nothing clear gives null: delivered text, a bare keyword, an impossible day, a time only', () => {
  assert.equal(parseExpectedDelivery('Delivered Nov 23', SEEN), null);
  assert.equal(parseExpectedDelivery('Arriving', SEEN), null);
  assert.equal(parseExpectedDelivery('Arriving by 8 PM', SEEN), null);
  assert.equal(parseExpectedDelivery('Arriving Feb 30', SEEN), null);
  assert.equal(parseExpectedDelivery('Delivered by Amazon Logistics', SEEN), null);
  assert.equal(parseExpectedDelivery('', SEEN), null);
  assert.equal(parseExpectedDelivery('Arriving tomorrow', new Date('nope')), null);
});

const existing = { start: day('2026-11-30'), end: day('2026-11-30'), source: 'email', seenAt: new Date('2026-11-20T10:00:00Z') };
const incoming = (seenAt: string, over: Record<string, unknown> = {}) =>
  ({ start: day('2026-11-25'), end: day('2026-11-25'), source: 'amazon-page' as const, seenAt: new Date(seenAt), ...over });
const NOW = new Date('2026-11-21T12:00:00Z');

test('the most recently SEEN observation wins, not the latest date', () => {
  // Earlier date, newer sighting: it replaces the later date.
  assert.equal(decideExpected(existing, incoming('2026-11-21T09:00:00Z'), NOW), 'write');
  // Later date, older sighting: skipped.
  assert.equal(decideExpected(existing, incoming('2026-11-19T09:00:00Z', { start: day('2026-12-05'), end: day('2026-12-05') }), NOW), 'skip');
  // The same moment: the stored one stays.
  assert.equal(decideExpected(existing, incoming('2026-11-20T10:00:00Z'), NOW), 'skip');
});

test('nothing stored, or stored without a seen time, takes the observation; bad input is skipped', () => {
  assert.equal(decideExpected(null, incoming('2026-11-19T09:00:00Z'), NOW), 'write');
  assert.equal(decideExpected({ ...existing, seenAt: null }, incoming('2026-11-19T09:00:00Z'), NOW), 'write');
  assert.equal(decideExpected(null, incoming('2026-11-19T09:00:00Z', { source: 'guess' }), NOW), 'skip');
  assert.equal(decideExpected(null, incoming('2026-11-19T09:00:00Z', { end: day('2026-11-20') }), NOW), 'skip');
  assert.equal(decideExpected(null, incoming('nope'), NOW), 'skip');
  assert.equal(decideExpected(null, incoming('2026-12-25T09:00:00Z'), NOW), 'skip', 'seen in the future');
});

test('display: arriving, expected range, late in amber, and the tooltip names source and seen day', () => {
  const now = new Date('2026-11-24T20:00:00Z');
  const one = expectedDisplay({ start: day('2026-11-30'), end: day('2026-11-30'), source: 'amazon-page', seenAt: new Date('2026-11-23T18:00:00Z') }, now);
  assert.deepEqual([one.text, one.late], ['Arriving Nov 30', false]);
  assert.equal(one.tooltip, 'Expected Nov 30 (from Amazon page, seen Nov 23)');
  const range = expectedDisplay({ start: day('2026-11-28'), end: day('2026-12-02'), source: 'email', seenAt: null }, now);
  assert.deepEqual([range.text, range.late], ['Expected Nov 28–Dec 2', false]);
  assert.equal(range.tooltip, 'Expected Nov 28–Dec 2 (from email)');
  const late = expectedDisplay({ start: day('2026-11-23'), end: day('2026-11-23'), source: 'carrier', seenAt: null }, now);
  assert.deepEqual([late.text, late.late], ['Late · expected Nov 23', true]);
  // Today is not late yet; a window still open is not late.
  assert.equal(expectedDisplay({ start: day('2026-11-24'), end: day('2026-11-24'), source: null, seenAt: null }, now).late, false);
  assert.equal(expectedDisplay({ start: day('2026-11-20'), end: day('2026-11-25'), source: null, seenAt: null }, now).late, false);
  assert.equal(expectedRangeText(day('2026-11-28'), day('2026-11-30')), 'Nov 28–30');
});
