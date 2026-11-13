import test from 'node:test';
import assert from 'node:assert/strict';

import { parseReceipt } from './receiptParse.ts';
import { matchPhoto, costcoBarcodes, costcoSourceLines, printedIds, parseCostcoBarcode, printedCostcoBarcodes, type MatchOrder } from './photoMatch.ts';

const order = (o: Partial<MatchOrder> & { id: number }): MatchOrder => ({
  orderNumber: null, orderDate: '2026-10-20T19:00:00.000Z', cost: 100, shippingCost: 0, cardLast4s: [], ...o,
});

test('parseReceipt: label and amount on separate lines, subtotal not taken as total', () => {
  const r = parseReceipt(['BEST BUY', 'SUBTOTAL', '$499.99', 'SALES TAX 44.37', 'TOTAL', '$544.36', 'VISA ****4821', '10/21/2026 3:14 PM']);
  assert.equal(r.subtotal, 499.99);
  assert.equal(r.total, 544.36);
  assert.equal(r.date, '2026-10-21');
  assert.deepEqual(r.last4, ['4821']);
});

test('parseReceipt: order total beats a bare total, item count is not a total', () => {
  const r = parseReceipt(['Total items: 3', 'Total $12.00', 'Order Total: $1,234.56', 'Oct 3, 2026']);
  assert.equal(r.total, 1234.56);
  assert.equal(r.date, '2026-10-03');
});

test('parseReceipt: a bare 4-digit number is not a card', () => {
  const r = parseReceipt(['STORE 1234', 'REG 0042', 'ending in 9911']);
  assert.deepEqual(r.last4, ['9911']);
});

test('gift card number on file is an exact match and names the card', () => {
  const m = matchPhoto(
    { texts: ['6006 4912 3456 7890'], candidates: ['6006491234567890'], looksLikeReceipt: false },
    [order({ id: 1 }), order({ id: 2 })],
    [{ id: 10, orderId: 2, cardNumber: '6006-4912-3456-7890' }, { id: 11, orderId: 1, cardNumber: '6006491234567891' }],
  );
  assert.equal(m.strength, 'exact');
  assert.equal(m.orderId, 2);
  assert.equal(m.giftCardId, 10);
});

test('a one-digit-off card number does not match', () => {
  const m = matchPhoto(
    { texts: [], candidates: ['6006491234567899'], looksLikeReceipt: false },
    [order({ id: 1 })],
    [{ id: 10, orderId: 1, cardNumber: '6006491234567890' }],
  );
  assert.equal(m.strength, 'none');
  assert.equal(m.orderId, null);
});

test('order number on a receipt is exact', () => {
  const m = matchPhoto(
    { texts: ['Order # 112-3456789-0123456', 'Order Total $50.00'], candidates: [], looksLikeReceipt: true },
    [order({ id: 1, orderNumber: '112-3456789-0123456' }), order({ id: 2, cost: 50 })],
    [],
  );
  assert.equal(m.strength, 'exact');
  assert.equal(m.orderId, 1);
});

test('receipt total with tax + date + card picks the one order (likely, not exact)', () => {
  const orders = [
    order({ id: 1, cost: 499.99, orderDate: '2026-10-21T00:00:00Z', cardLast4s: ['4821'] }),
    order({ id: 2, cost: 499.99, orderDate: '2026-10-21T00:00:00Z', cardLast4s: ['1111'] }),
    order({ id: 3, cost: 499.99, orderDate: '2026-09-01T00:00:00Z', cardLast4s: ['4821'] }),
  ];
  const m = matchPhoto(
    { texts: ['TOTAL', '$544.36', 'VISA ****4821', '10/21/2026'], candidates: [], looksLikeReceipt: true },
    orders, [],
  );
  assert.equal(m.strength, 'likely');
  assert.equal(m.orderId, 1);
});

test('two orders that fit equally are ambiguous', () => {
  const orders = [order({ id: 1, cost: 20 }), order({ id: 2, cost: 20 })];
  const m = matchPhoto({ texts: ['Subtotal $20.00', '10/20/2026'], candidates: [], looksLikeReceipt: true }, orders, []);
  assert.equal(m.strength, 'ambiguous');
  assert.deepEqual(m.alternatives.sort(), [1, 2]);
});

test('a total above the tax band does not match', () => {
  const m = matchPhoto({ texts: ['Total $130.00', '10/20/2026'], candidates: [], looksLikeReceipt: true }, [order({ id: 1, cost: 100 })], []);
  assert.equal(m.strength, 'none');
});

test('no receipt date falls back to the photo date (on or after the order)', () => {
  const orders = [order({ id: 1, cost: 40, orderDate: '2026-10-01T00:00:00Z' }), order({ id: 2, cost: 40, orderDate: '2026-08-01T00:00:00Z' })];
  const m = matchPhoto({ texts: ['Subtotal 40.00'], candidates: [], looksLikeReceipt: true, capturedAt: '2026-10-03T12:00:00Z' }, orders, []);
  assert.equal(m.strength, 'likely');
  assert.equal(m.orderId, 1);
});

test('receipt card contradicting the order card rules it out', () => {
  const m = matchPhoto(
    { texts: ['Subtotal $20.00', '10/20/2026', 'XXXXXXXXXXXX9999'], candidates: [], looksLikeReceipt: true },
    [order({ id: 1, cost: 20, cardLast4s: ['1111'] })], [],
  );
  assert.equal(m.strength, 'none');
});

const COSTCO = '21132000900752610281153';

test('costcoBarcodes: summary line rebuilds the receipt barcode (date read apart)', () => {
  assert.ok(costcoBarcodes(['10/28/2026', '11:53 1320 9 75 13']).includes(COSTCO));
  assert.ok(costcoBarcodes(['Purchased from Whse 1320', '10/28/2026 11:53 1320 9 75 13']).includes(COSTCO));
});

test('costcoBarcodes: no date on the photo tries the month before it was taken', () => {
  assert.ok(costcoBarcodes(['11:53 1320 9 75 13'], '2026-11-04T20:00:00Z').includes(COSTCO));
  assert.deepEqual(costcoBarcodes(['11:53 1320 9 75 13']), []);
});

test('matchPhoto: Costco summary receipt matches its order exactly', () => {
  const orders = [order({ id: 1, orderNumber: COSTCO }), order({ id: 2, orderNumber: '21132000900742610281150' })];
  const m = matchPhoto({ texts: ['Costco Summary Receipt', '10/28/2026', '11:53 1320 9 75 13', 'UBER EATS', 'ACTIVATED'], candidates: [], looksLikeReceipt: true }, orders, []);
  assert.equal(m.strength, 'exact');
  assert.equal(m.orderId, 1);
});

test('matchPhoto: unlabelled barcode number printed on the receipt matches exactly', () => {
  const m = matchPhoto({ texts: ['Thank You!', COSTCO], candidates: [], looksLikeReceipt: true }, [order({ id: 7, orderNumber: COSTCO })], []);
  assert.equal(m.strength, 'exact');
  assert.equal(m.orderId, 7);
});

test('printedIds: short numbers are not identifiers', () => {
  assert.deepEqual(printedIds(['Whse 1320', 'Seq# 9747']), []);
});

test('unknown gift card taken minutes after a photo on one order is a likely match to it', () => {
  const orders = [
    order({ id: 1, photoTimes: ['2026-10-21T15:00:00.000Z'] }),
    order({ id: 2, photoTimes: ['2026-10-21T18:00:00.000Z'] }),
    order({ id: 3 }),
  ];
  const m = matchPhoto({ texts: ['GIFT CARD'], candidates: ['TESTCODE00AA11'], looksLikeReceipt: false, takenAt: '2026-10-21T15:06:00.000Z' }, orders, []);
  assert.equal(m.strength, 'likely');
  assert.equal(m.orderId, 1);
  assert.match(m.reason, /6 minutes/);
});

test('gift card near photos on two orders is ambiguous, and with no taken time is no match', () => {
  const orders = [order({ id: 1, photoTimes: ['2026-10-21T15:00:00.000Z'] }), order({ id: 2, photoTimes: ['2026-10-21T15:10:00.000Z'] })];
  const input = { texts: ['GIFT CARD'], candidates: ['TESTCODE00AA11'], looksLikeReceipt: false };
  const amb = matchPhoto({ ...input, takenAt: '2026-10-21T15:05:00.000Z' }, orders, []);
  assert.equal(amb.strength, 'ambiguous');
  assert.deepEqual(amb.alternatives, [1, 2]);
  // Upload time alone (capturedAt) never pairs a card with an order.
  assert.equal(matchPhoto({ ...input, capturedAt: '2026-10-21T15:05:00.000Z' }, orders, []).strength, 'none');
  // Too far apart.
  assert.equal(matchPhoto({ ...input, takenAt: '2026-10-21T16:00:00.000Z' }, orders, []).strength, 'none');
});

test('costcoSourceLines finds the lines a rebuilt Costco order number came from', () => {
  const texts = ['MEMBER 111222333444', 'Shop Card', '10/28/2026', '11:53 1320 9 75 13', 'THANK YOU'];
  const num = costcoBarcodes(texts)[0];
  assert.deepEqual(costcoSourceLines(texts, num), ['10/28/2026', '11:53 1320 9 75 13']);
  assert.deepEqual(costcoSourceLines(texts, '113-1234567-1234567'), []);
  assert.deepEqual(costcoSourceLines(['10/29/2026', '11:54 1320 9 76 13'], num), []);
});

test('parseCostcoBarcode and printedCostcoBarcodes: a real date and time, nothing else', () => {
  assert.deepEqual(parseCostcoBarcode('21132000802312611111324'), { warehouse: 1320, register: 8, transaction: 231, date: '2026-11-11', time: '13:24' });
  assert.equal(parseCostcoBarcode('21132000802312613411324'), null);
  assert.deepEqual(printedCostcoBarcodes(['2113 2000 8023 1261 1111 324', 'MEMBER 111122223333']), ['21132000802312611111324']);
});

test('matchPhoto: an activation receipt with its cards matches the order of the same Costco transaction', () => {
  const orders = [order({ id: 9, orderNumber: '21132000802312611111324', orderDate: '2026-11-11T20:00:00.000Z' }), order({ id: 10, orderNumber: '21132000802302611111320' })];
  const texts = ['Costco Summary Receipt', '13:23 1320 8 231 8', 'PC 7000000000000001 ACTIVATED'];
  const m = matchPhoto({ texts, candidates: ['AAAABBBBCCCCDDDD'], looksLikeReceipt: false, capturedAt: '2026-11-11T22:00:00Z' }, orders, []);
  assert.equal(m.strength, 'likely');
  assert.equal(m.orderId, 9);
  // A printed date on the same day is exact; a printed date a day off is no match.
  assert.equal(matchPhoto({ texts: [...texts, '11/11/2026'], candidates: [], looksLikeReceipt: false }, orders, []).strength, 'exact');
  assert.equal(matchPhoto({ texts: [...texts, '11/12/2026'], candidates: [], looksLikeReceipt: false }, orders, []).orderId, null);
  // Taken more than 3 days later: no match.
  assert.equal(matchPhoto({ texts, candidates: [], looksLikeReceipt: false, capturedAt: '2026-11-16T22:00:00Z' }, orders, []).orderId, null);
});
