import test from 'node:test';
import assert from 'node:assert/strict';
import { beforeOrder, merchantSourceFor, decideMerchantDelivery, wallClockFromEmailDate, merchantDeliveredAt, earlierShipDate, deliveredNumbers, relativeDeliveredAt } from './merchantDelivery.ts';

// All numbers below are made up.
const NOW = new Date('2026-11-26T12:00:00Z');
const d = (s: string) => new Date(s);

test('only Amazon and Walmart own deliveries use the merchant source', () => {
  assert.equal(merchantSourceFor({ platform: 'Amazon', orderNumber: '111-2223334-5556667' }, 'TBA123456789012'), 'amazon');
  assert.equal(merchantSourceFor({ platform: 'Amazon', orderNumber: '111-2223334-5556667' }, '1Z999AA10123456784'), null);
  assert.equal(merchantSourceFor({ platform: 'Amazon', orderNumber: '111-2223334-5556667' }, '123456789012'), null);
  assert.equal(merchantSourceFor({ platform: 'Amazon', orderNumber: '111-2223334-5556667' }, 'abc'), 'amazon');
  assert.equal(merchantSourceFor({ platform: 'Walmart', orderNumber: '200000000000001' }, '200000000000001'), 'walmart');
  assert.equal(merchantSourceFor({ platform: 'Walmart', orderNumber: '200000000000001' }, '1Z999AA10123456784'), null);
  assert.equal(merchantSourceFor({ platform: 'Walmart', orderNumber: '200000000000001' }, '1Z999AA10123456784', 'Walmart'), 'walmart');
  assert.equal(merchantSourceFor({ platform: 'Costco', orderNumber: '1' }, 'abc'), null);
});

test('a new row is created, a carrier-page row is never touched', () => {
  assert.deepEqual(decideMerchantDelivery(null, d('2026-11-23T14:00:00Z'), NOW), { action: 'create', deliveredAt: d('2026-11-23T14:00:00Z') });
  assert.equal(decideMerchantDelivery({ source: 'carrier-page', deliveredAt: d('2026-11-25T00:00:00Z') }, d('2026-11-23T14:00:00Z'), NOW).action, 'skip');
});

test('a carrier-page row with no delivered date yet does not block the merchant date', () => {
  assert.deepEqual(decideMerchantDelivery({ source: 'carrier-page', deliveredAt: null }, d('2026-11-23T14:00:00Z'), NOW), { action: 'update', deliveredAt: d('2026-11-23T14:00:00Z') });
});

test('beforeOrder keeps a date-only order on its own day', () => {
  // Walmart sync stores '2026-11-20' as UTC midnight; its Los Angeles day would be the 19th.
  const dateOnly = d('2026-11-20T00:00:00Z');
  assert.equal(beforeOrder(d('2026-11-19T15:00:00Z'), dateOnly), true);
  assert.equal(beforeOrder(d('2026-11-20T08:00:00Z'), dateOnly), false);
});

test('beforeOrder compares Los Angeles days, not the process zone', () => {
  // 03:30 UTC on Nov 21 is the evening of Nov 20 in Los Angeles.
  const ordered = d('2026-11-21T03:30:00Z');
  assert.equal(beforeOrder(d('2026-11-20T19:00:00Z'), ordered), false);
  assert.equal(beforeOrder(d('2026-11-20T00:00:00Z'), ordered), false);
  assert.equal(beforeOrder(d('2026-11-19T23:00:00Z'), ordered), true);
  assert.equal(beforeOrder(d('2026-11-19T23:00:00Z'), null), false);
  // An evening delivered email on the order's own day is kept.
  assert.equal(merchantDeliveredAt({ emailDate: '2026-11-21T03:30:00Z', now: NOW, orderDate: ordered })?.toISOString(), '2026-11-20T19:30:00.000Z');
  assert.equal(decideMerchantDelivery(null, d('2026-11-20T19:30:00Z'), NOW, ordered).action, 'create');
});

test('a delivered date only moves earlier', () => {
  const have = { source: 'amazon', deliveredAt: d('2026-11-23T14:00:00Z') };
  assert.equal(decideMerchantDelivery(have, d('2026-11-24T10:00:00Z'), NOW).action, 'skip');
  assert.equal(decideMerchantDelivery(have, d('2026-11-23T14:00:00Z'), NOW).action, 'skip');
  assert.deepEqual(decideMerchantDelivery(have, d('2026-11-22T09:00:00Z'), NOW), { action: 'update', deliveredAt: d('2026-11-22T09:00:00Z') });
  // A row that only holds a ship date gets its first delivered date.
  assert.equal(decideMerchantDelivery({ source: 'email', deliveredAt: null }, d('2026-11-23T14:00:00Z'), NOW).action, 'update');
});

test('a future or invalid date is not written', () => {
  assert.equal(decideMerchantDelivery(null, d('2026-12-30T00:00:00Z'), NOW).action, 'skip');
  assert.equal(decideMerchantDelivery(null, new Date('nope'), NOW).action, 'skip');
});

test('an email date becomes Pacific wall-clock time', () => {
  // 07:30 UTC in late November is 23:30 the evening before in Pacific time.
  assert.equal(wallClockFromEmailDate('2026-11-24T07:30:00Z')?.toISOString(), '2026-11-23T23:30:00.000Z');
  assert.equal(wallClockFromEmailDate('2026-07-01T07:05:00Z')?.toISOString(), '2026-07-01T00:05:00.000Z');
  assert.equal(wallClockFromEmailDate(''), null);
  assert.equal(wallClockFromEmailDate('not a date'), null);
  assert.equal(wallClockFromEmailDate(null), null);
});

test('the page date wins over the email date, the email date fills in when the page gave none', () => {
  assert.equal(merchantDeliveredAt({ pageText: 'Delivered Nov 20', emailDate: '2026-11-24T20:00:00Z', now: NOW })?.toISOString(), '2026-11-20T12:00:00.000Z');
  assert.equal(merchantDeliveredAt({ pageText: 'Delivered today', emailDate: '2026-11-24T20:00:00Z', now: NOW })?.toISOString(), '2026-11-24T12:00:00.000Z');
  assert.equal(merchantDeliveredAt({ emailDate: '2026-11-24T20:00:00Z', now: NOW })?.toISOString(), '2026-11-24T12:00:00.000Z');
  // With no email, "today" is dated from now (NOW is 04:00 Pacific, before noon, so now itself).
  assert.equal(merchantDeliveredAt({ pageText: 'Delivered today', now: NOW })?.toISOString(), '2026-11-26T04:00:00.000Z');
});

test('a delivered signal only speaks for numbers it can be tied to', () => {
  assert.deepEqual(deliveredNumbers({ hasPageText: true, rowNumbers: ['A', 'B'], storedNumbers: [] }), ['A', 'B']);
  assert.deepEqual(deliveredNumbers({ hasPageText: true, rowNumbers: [], storedNumbers: ['C'] }), ['C']);
  assert.deepEqual(deliveredNumbers({ hasPageText: false, emailNumbers: ['A'], rowNumbers: ['A', 'B'], storedNumbers: [] }), ['A']);
  // An email with no number: one shipment is clear, two are not.
  assert.deepEqual(deliveredNumbers({ hasPageText: false, emailNumbers: [], rowNumbers: [], storedNumbers: ['C'] }), ['C']);
  assert.deepEqual(deliveredNumbers({ hasPageText: false, emailNumbers: [], rowNumbers: ['A'], storedNumbers: ['A'] }), ['A']);
  assert.deepEqual(deliveredNumbers({ hasPageText: false, emailNumbers: [], rowNumbers: ['A'], storedNumbers: ['C'] }), []);
  assert.deepEqual(deliveredNumbers({ hasPageText: false, rowNumbers: [], storedNumbers: [] }), []);
});

test('earlierShipDate keeps the earlier valid date', () => {
  assert.equal(earlierShipDate(d('2026-11-20T00:00:00Z'), d('2026-11-18T00:00:00Z'))?.toISOString(), '2026-11-18T00:00:00.000Z');
  assert.equal(earlierShipDate(null, d('2026-11-18T00:00:00Z'))?.toISOString(), '2026-11-18T00:00:00.000Z');
  assert.equal(earlierShipDate(new Date('x'), null), null);
});

test('a delivered date before the order, or an estimate, is not recorded', () => {
  const now = new Date('2026-11-27T12:00:00Z');
  const ordered = new Date('2026-11-25T16:00:00Z');
  assert.equal(merchantDeliveredAt({ pageText: 'Delivered Dec 11', now, orderDate: ordered }), null);
  assert.equal(merchantDeliveredAt({ pageText: 'Delivered Nov 26', now, orderDate: ordered })?.toISOString(), '2026-11-26T12:00:00.000Z');
  assert.equal(merchantDeliveredAt({ emailDate: '2026-11-20T10:00:00Z', now, orderDate: ordered }), null);
  assert.deepEqual(decideMerchantDelivery(null, d('2025-12-11T12:00:00Z'), now, ordered), { action: 'skip' });
});

test('a stored date from before the order is replaced by a later correct one', () => {
  const now = new Date('2026-11-27T12:00:00Z');
  const ordered = new Date('2026-11-25T16:00:00Z');
  const bad = { source: 'walmart', deliveredAt: d('2025-12-11T12:00:00Z') };
  const at = d('2026-11-26T12:00:00Z');
  assert.deepEqual(decideMerchantDelivery(bad, at, now, ordered), { action: 'update', deliveredAt: at });
});

test('a USPS number on an Amazon or Walmart order takes the merchant word (there is no USPS lookup)', () => {
  const usps = '9400111899223344556677';
  assert.equal(merchantSourceFor({ platform: 'Walmart', orderNumber: '200000000000001' }, usps), 'walmart');
  assert.equal(merchantSourceFor({ platform: 'Amazon', orderNumber: '111-2223334-5556667' }, usps), 'amazon');
  assert.equal(merchantSourceFor({ platform: 'Costco', orderNumber: '1' }, usps), null);
  assert.equal(merchantSourceFor({ platform: 'Walmart', orderNumber: '200000000000001' }, usps, 'USPS'), 'walmart');
});

test('"Delivered today" and "yesterday" on a merchant page are dated from now, in Pacific time', () => {
  // 2026-11-28 13:00 PST.
  const now = d('2026-11-28T21:00:00Z');
  assert.deepEqual(relativeDeliveredAt('Delivered today', now), d('2026-11-28T12:00:00Z'));
  assert.deepEqual(relativeDeliveredAt('Delivered today, 10:42am', now), d('2026-11-28T10:42:00Z'));
  assert.deepEqual(relativeDeliveredAt('Delivered yesterday at 3:05 PM', now), d('2026-11-27T15:05:00Z'));
  assert.deepEqual(relativeDeliveredAt('Arriving soon\nToday · Delivered', now), d('2026-11-28T12:00:00Z'));
  // Before noon with no time: now, never later.
  assert.deepEqual(relativeDeliveredAt('Delivered today', d('2026-11-28T17:30:00Z')), d('2026-11-28T09:30:00Z'));
  // Late at night UTC is still the Pacific day before.
  assert.deepEqual(relativeDeliveredAt('Delivered today', d('2026-11-29T06:00:00Z')), d('2026-11-28T12:00:00Z'));
});

test('a relative line that is not a delivery, or is in the future, gives nothing', () => {
  const now = d('2026-11-28T21:00:00Z');
  assert.equal(relativeDeliveredAt('Arrives today by 9pm', now), null);
  assert.equal(relativeDeliveredAt('Not delivered today', now), null);
  assert.equal(relativeDeliveredAt('Will be delivered today', now), null);
  assert.equal(relativeDeliveredAt('Delivered today, 11:50pm', now), null);
  assert.equal(relativeDeliveredAt('Delivered', now), null);
  assert.equal(relativeDeliveredAt('', now), null);
});

test('a page that says "Delivered today" gets a delivered time; an absolute date still wins', () => {
  const now = d('2026-11-28T21:00:00Z');
  const orderDate = d('2026-11-25T10:00:00Z');
  assert.deepEqual(merchantDeliveredAt({ pageText: 'Delivered today\nYour package was left at the front door', now, orderDate }), d('2026-11-28T12:00:00Z'));
  assert.deepEqual(merchantDeliveredAt({ pageText: 'Delivered yesterday', now, orderDate }), d('2026-11-27T12:00:00Z'));
  // Yesterday before the order's day is not this order's delivery.
  assert.equal(merchantDeliveredAt({ pageText: 'Delivered yesterday', now, orderDate: d('2026-11-28T08:00:00Z') }), null);
});
