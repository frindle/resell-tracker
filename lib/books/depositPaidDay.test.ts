// Deposit matching's paid day (depositPaidDay) and BG's credit day from receipts. Made-up data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { depositPaidDay, bestEventDate, realEventDate, type OrderForBooks } from './orderPostings.ts';
import { attributeReceipts } from '../bgReceiptAttribution.ts';
import { suggestDeposits, type MatchPayout, type MatchTxn } from './match.ts';

const CTX = { goLive: '2027-01-01', now: new Date('2026-11-27T20:00:00Z') };
const ord = (o: Partial<OrderForBooks> = {}): OrderForBooks => ({
  id: 1, platform: 'Acme', orderDate: '2026-10-01T20:00:00Z', cost: 10, shippingCost: 0, salePrice: 50, buyerId: 1, cardId: null,
  cashbackAmount: 0, portalCashback: null, amexOfferDollars: null, bgPaidAmount: 50, bfmrStatus: null, lost: false, cancelled: false,
  ignoredByRule: false, giftCards: [], returns: [], ...o,
});

test('real BG credit day is the paid day, even over an inferred go-live stamp', () => {
  const o = ord({ bgPaidAt: '2026-10-15T18:00:00Z' });
  assert.equal(depositPaidDay(o, undefined, CTX), '2026-10-15');
  assert.equal(depositPaidDay(o, { date: '2026-12-31', inferred: true }, CTX), '2026-10-15');
});

test('a real (not inferred) stamp still wins', () => {
  assert.equal(depositPaidDay(ord({ bgPaidAt: '2026-10-15T18:00:00Z' }), { date: '2026-10-20', inferred: false }, CTX), '2026-10-20');
});

test('no real date: the order date, not go-live minus a day; after go-live with nothing: today', () => {
  assert.equal(depositPaidDay(ord(), undefined, CTX), '2026-10-01');
  assert.equal(depositPaidDay(ord(), { date: '2026-12-31', inferred: true }, CTX), '2026-10-01');
  assert.equal(depositPaidDay(ord({ orderDate: '2027-01-05T20:00:00Z' }), undefined, { goLive: '2027-01-01', now: new Date('2027-01-10T20:00:00Z') }), '2027-01-10');
});

test('the credit day is clamped to the order date and to today', () => {
  assert.equal(depositPaidDay(ord({ bgPaidAt: '2026-09-01T18:00:00Z' }), undefined, CTX), '2026-10-01');
  assert.equal(depositPaidDay(ord({ bgPaidAt: '2026-12-20T18:00:00Z' }), undefined, CTX), '2026-11-27');
});

test('the books stamps ignore bgPaidAt: still go-live minus a day, inferred', () => {
  const o = ord({ bgPaidAt: '2026-10-15T18:00:00Z' });
  assert.equal(realEventDate(o, 'paid'), null);
  assert.deepEqual(bestEventDate(o, 'paid', { ...CTX, hasOpening: false }), { date: '2026-12-31', inferred: true });
});

test('an order with a BG credit day matches a deposit made after it; the old inferred day could not', () => {
  const t: MatchTxn = { id: 9, accountId: 2, postedDate: '2026-11-25', amountCents: 5000, description: 'ACH CREDIT BUYERCO', matchStatus: 'unmatched' };
  const mk = (paidDay: string): MatchPayout => ({ orderId: 1, buyerId: 1, paidDay, paidCents: 5000, openCents: 5000 });
  assert.equal(suggestDeposits([t], new Set([2]), [mk('2026-12-31')], new Map()).length, 0);
  assert.equal(suggestDeposits([t], new Set([2]), [mk(depositPaidDay(ord({ bgPaidAt: '2026-11-20T10:00:00Z' }), { date: '2026-12-31', inferred: true }, CTX))], new Map()).length, 1);
});

test('attributeReceipts: earliest paid receipt created_dt per order; unpaid receipts give none', () => {
  const orders = [{ id: 1, orderNumber: '111222333', salePrice: 50, bgExpectedPayout: 50, trackingNumbers: null, buyer: null },
    { id: 2, orderNumber: '444555666', salePrice: 20, bgExpectedPayout: 20, trackingNumbers: null, buyer: null }];
  const receipts = [
    { receipt_id: 1, order_number: '111222333', total: '30', paid: true, status: 'paid', created_dt: '2026-10-12T10:00:00Z' },
    { receipt_id: 2, order_number: '111222333', total: '20', paid: true, status: 'paid', created_dt: '2026-10-10T10:00:00Z' },
    { receipt_id: 3, order_number: '444555666', total: '20', paid: false, status: 'verified', created_dt: '2026-10-11T10:00:00Z' },
  ];
  const r = attributeReceipts(orders, receipts, { creditedOnly: new Set(), syncStartDate: null, cutoff: new Date('2026-01-01') });
  assert.equal(r.paidAtByOrder.get(1)?.toISOString(), '2026-10-10T10:00:00.000Z');
  assert.equal(r.paidAtByOrder.has(2), false);
});
