import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildResetLines, formatResetTime, isApple, resetRanges, shortName, type ResetOrder } from './resetLines.ts';
import { buildDigestLines, lineLooksPrivate, MAX_LINES, type DigestCounts } from './digestLines.ts';

const Z = (s: string) => new Date(s);
const base: ResetOrder = { platform: 'Amazon', itemDescription: 'Widget', cancelled: false, orderedAt: null, egiftDeliveredAt: null };
// Digest day D = Nov 15 2026 (LA); the lines are read on Nov 16, so resets listed fall on Nov 16.
const D = '2026-11-15';
const amazon = (at: string, desc = 'Widget', extra: Partial<ResetOrder> = {}): ResetOrder => ({ ...base, itemDescription: desc, orderedAt: Z(at), ...extra });
const walmart = (at: string, desc = 'Toy Truck'): ResetOrder => ({ ...base, platform: 'Walmart', itemDescription: desc, orderedAt: Z(at) });
const costco = (delivered: string, ordered = '2026-11-01T00:00:00Z', desc = 'Costco Shop Card'): ResetOrder =>
  ({ ...base, platform: 'Costco', itemDescription: desc, orderedAt: Z(ordered), egiftDeliveredAt: Z(delivered) });

test('the Amazon window is the 7 days before the LA day after D, to the minute', () => {
  const r = resetRanges(D).Amazon;
  assert.deepEqual([r.from, r.to], [Z('2026-11-09T08:00:00Z'), Z('2026-11-10T08:00:00Z')]);
  const lines = buildResetLines(D, [
    amazon('2026-11-09T07:59:00Z', 'Early'), // resets 11:59 PM on the 15th: yesterday's
    amazon('2026-11-09T08:00:00Z', 'First'), // 12:00 AM on the 16th
    amazon('2026-11-10T07:59:00Z', 'Last'), // 11:59 PM on the 16th
    amazon('2026-11-10T08:00:00Z', 'Next'), // the 17th
  ]);
  assert.deepEqual(lines, ['Amazon limits reset today: 2 products.', 'First 12:00 AM; Last 11:59 PM']);
});

test('the window follows the LA calendar across a DST change', () => {
  // Reset day Nov 2 2026 (clocks went back Nov 1): its start minus 7 days is Oct 26 01:00 PDT.
  const r = resetRanges('2026-11-01').Amazon;
  assert.deepEqual([r.from, r.to], [Z('2026-10-26T08:00:00Z'), Z('2026-10-27T08:00:00Z')]);
  const lines = buildResetLines('2026-11-01', [
    amazon('2026-10-26T07:59:00Z', 'Before'),
    amazon('2026-10-26T08:00:00Z', 'Midnight'),
    amazon('2026-10-27T07:59:00Z', 'Late'),
    amazon('2026-10-27T08:00:00Z', 'After'),
  ]);
  assert.deepEqual(lines, ['Amazon limits reset today: 2 products.', 'Midnight 12:00 AM; Late 11:59 PM']);
  // And the spring change: reset day Mar 9 2026 (clocks went forward Mar 8).
  const s = resetRanges('2026-03-08').Amazon;
  assert.deepEqual([s.from, s.to], [Z('2026-03-02T07:00:00Z'), Z('2026-03-03T07:00:00Z')]);
});

test('reset times read in LA time, to the minute', () => {
  assert.equal(formatResetTime(Z('2026-11-16T23:42:00Z')), '3:42 PM');
  assert.equal(formatResetTime(Z('2026-07-16T19:05:00Z')), '12:05 PM');
});

test('cancelled orders, unknown times and other retailers are left out', () => {
  const at = '2026-11-09T20:00:00Z';
  assert.deepEqual(buildResetLines(D, [
    amazon(at, 'Gone', { cancelled: true }),
    { ...base, orderedAt: null },
    { ...base, platform: 'Target', orderedAt: Z(at) },
  ]), []);
});

test('products are grouped, ordered by reset time, with the quantity when known', () => {
  const lines = buildResetLines(D, [
    amazon('2026-11-09T22:00:00Z', 'Alpha Gadget'),
    amazon('2026-11-09T16:00:00Z', 'Beta Lamp', { items: [{ title: 'Beta Lamp Pro', quantity: 3 }, { title: 'Cable', quantity: 1, qtyAssumed: true }] }),
    amazon('2026-11-09T18:30:00Z', 'alpha gadget'),
  ]);
  assert.deepEqual(lines, [
    'Amazon limits reset today: 3 products.',
    'Beta Lamp Pro 8:00 AM x3; Cable 8:00 AM; Alpha Gadget 10:30 AM, 2:00 PM',
  ]);
});

test('Walmart: each non-Apple order frees its slot 24 hours after it was placed', () => {
  const r = resetRanges(D).Walmart;
  assert.deepEqual([r.from, r.to], [Z('2026-11-15T08:00:00Z'), Z('2026-11-16T08:00:00Z')]);
  const lines = buildResetLines(D, [
    walmart('2026-11-15T07:59:00Z'), // slot freed on the 15th
    walmart('2026-11-15T21:15:00Z'), // 1:15 PM tomorrow
    walmart('2026-11-15T12:02:00Z'), // 4:02 AM tomorrow
    walmart('2026-11-16T08:00:00Z'), // the 17th
    { ...walmart('2026-11-15T10:00:00Z'), cancelled: true },
  ]);
  assert.deepEqual(lines, ['Walmart order slots free today: 4:02 AM, 1:15 PM.']);
});

test('Walmart: Apple products have no slot rule and are left out', () => {
  for (const d of ['Apple AirPods Pro', 'iPhone 17 case bundle', 'iPad Air', 'MacBook Air 13', 'Apple Watch Band', 'AirTag 4 Pack', 'Mac mini M4', 'Mac Studio', 'Apple Pencil', 'Apple TV 4K', 'HomePod mini']) {
    assert.equal(isApple(d), true, d);
    assert.deepEqual(buildResetLines(D, [walmart('2026-11-15T21:15:00Z', d)]), [], d);
  }
  for (const d of ['Pineapple Slicer', 'Toy Truck', 'Grape Soda']) assert.equal(isApple(d), false, d);
  // The same Apple item on Amazon still follows Amazon's 7-day rule.
  assert.equal(buildResetLines(D, [amazon('2026-11-09T20:00:00Z', 'Apple AirPods Pro')]).length, 2);
});

test('Costco: 14 days from the eGift delivery time, not the order time', () => {
  const r = resetRanges(D).Costco;
  assert.deepEqual([r.from, r.to], [Z('2026-11-02T08:00:00Z'), Z('2026-11-03T08:00:00Z')]);
  // Delivered Nov 2 (resets Nov 16), ordered long before: listed.
  assert.deepEqual(buildResetLines(D, [costco('2026-11-02T18:30:00Z', '2026-10-01T00:00:00Z', 'Costco Shop Card 100')]),
    ['Costco gift card limit resets today: 1 order.', 'Costco Shop Card 10:30 AM']);
  // Ordered 14 days before the reset day but delivered later: not listed.
  assert.deepEqual(buildResetLines(D, [costco('2026-11-04T18:30:00Z', '2026-11-02T18:30:00Z')]), []);
  // No delivery time recorded: not listed.
  assert.deepEqual(buildResetLines(D, [{ ...costco('2026-11-02T18:30:00Z'), egiftDeliveredAt: null, orderedAt: Z('2026-11-02T18:30:00Z') }]), []);
});

test('retailers come in order Amazon, Walmart, Costco, each header only when it has resets', () => {
  const lines = buildResetLines(D, [costco('2026-11-02T18:30:00Z'), walmart('2026-11-15T21:15:00Z'), amazon('2026-11-09T20:00:00Z')]);
  assert.deepEqual(lines, [
    'Amazon limits reset today: 1 product.',
    'Widget 12:00 PM',
    'Walmart order slots free today: 1:15 PM.',
    'Costco gift card limit resets today: 1 order.',
    'Costco Shop Card 10:30 AM',
  ]);
  assert.deepEqual(buildResetLines(D, []), []);
});

test('lines are packed, capped at the budget, and end with "and N more"', () => {
  const many = Array.from({ length: 40 }, (_, i) => amazon(`2026-11-09T${String(8 + (i % 14)).padStart(2, '0')}:${String(i).padStart(2, '0')}:00Z`, `Prod${i} Thing`));
  const lines = buildResetLines(D, many, 3);
  assert.equal(lines.length, 3);
  assert.equal(lines[0], 'Amazon limits reset today: 40 products.');
  assert.match(lines[2], / and \d+ more\.$/);
  for (const l of lines) assert.ok(Array.from(l).length <= 200, l);
  // Every retailer gets a first line before any gets a second.
  const shared = buildResetLines(D, [...many, walmart('2026-11-15T21:15:00Z'), costco('2026-11-02T18:30:00Z')], 4);
  assert.equal(shared.length, 4);
  assert.ok(shared.some(l => l.startsWith('Walmart')));
  assert.ok(shared.some(l => l.startsWith('Costco')));
  // A budget of zero says nothing.
  assert.deepEqual(buildResetLines(D, many, 0), []);
});

test('names the queue would refuse are rewritten, never sent; no amounts or numbers leak', () => {
  assert.equal(shortName('Gift Card $100 for me@x.test 1234567'), 'Gift Card for');
  assert.equal(shortName('Costco Shop Card 100', true), 'Costco Shop Card');
  const lines = buildResetLines(D, [amazon('2026-11-09T20:00:00Z', '$50 me@x.test 1234567')]);
  assert.deepEqual(lines, ['Amazon limits reset today: 1 product.', 'item 12:00 PM']);
  for (const l of lines) assert.equal(lineLooksPrivate(l), false, l);
});

const none: DigestCounts = {
  ordersAdded: {}, addedWithoutCard: 0, syncRuns: 0, syncOrdersChanged: 0,
  cardsSubmitted: 0, waitingToShip: 0, pastShipBy: 0, unseenErrors: 0,
};

test('the digest keeps its count lines and adds the reset lines within the queue limits', () => {
  const orders = [amazon('2026-11-09T20:00:00Z', 'Widget'), walmart('2026-11-15T21:15:00Z')];
  const { lines } = buildDigestLines({ ...none, ordersAdded: { Walmart: 2 }, resets: { day: D, orders } });
  assert.deepEqual(lines, ['2 new orders (Walmart).', 'Amazon limits reset today: 1 product.', 'Widget 12:00 PM', 'Walmart order slots free today: 1:15 PM.']);
  // Without resets the digest is unchanged.
  assert.deepEqual(buildDigestLines(none).lines, ['No new orders.']);
  // A quiet day still lists resets, and the total never passes the queue's cap.
  const big = Array.from({ length: 60 }, (_, i) => amazon('2026-11-09T20:00:00Z', `Item${String.fromCharCode(65 + (i % 26))}${i % 7} Gear`));
  const busy = buildDigestLines({
    ordersAdded: { Walmart: 3 }, addedWithoutCard: 2, syncRuns: 12, syncOrdersChanged: 9,
    cardsSubmitted: 4, waitingToShip: 3, pastShipBy: 1, unseenErrors: 5, resets: { day: D, orders: big },
  }).lines;
  assert.ok(busy.length <= MAX_LINES);
  assert.equal(busy.at(-1)?.includes('more'), true);
  for (const l of busy) assert.equal(lineLooksPrivate(l) || Array.from(l).length > 200, false, l);
});
