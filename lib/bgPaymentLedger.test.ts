// Unit tests for the BG payment -> receipts ledger. Made-up ids and amounts only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPaymentLedger, heldReceiptKeys, uniqueSubset, receiptCreditsOf, orderCentsOfReceipts, bgTime, type ReceiptCredit } from './bgPaymentLedger.ts';

const t = (s: string) => bgTime(s)!;
const cr = (receiptId: string, cents: number, at: string): ReceiptCredit => ({ receiptId, cents, at: t(at) });
const pay = (id: string, cents: number, at: string) => ({ id, cents, at: t(at) });

test('bgTime reads BG and ISO stamps consistently', () => {
  assert.equal(bgTime('03-02-2027 10:00:00'), bgTime('2027-03-02T10:00:00'));
  assert.equal(bgTime('2027-03-02 10:00:00'), bgTime('2027-03-02T10:00:00Z'));
  assert.equal(bgTime('nope'), null);
});

test('a credit left over after a PAID payment matched by subset is held, not read as paid', () => {
  const credits = [cr('A', 10005, '2027-03-01T08:00:00'), cr('B', 5005, '2027-03-01T09:00:00'), cr('X', 905, '2027-03-01T10:00:00')];
  const l = buildPaymentLedger(credits, [pay('P1', 15010, '2027-03-01T12:00:00')]);
  assert.deepEqual([...(l.byPayment.get('P1') ?? [])].sort(), ['A', 'B']);
  assert.deepEqual(l.unassignedReceipts, ['X']);
  assert.deepEqual([...heldReceiptKeys(l, new Set())], ['X']);
});

test('heldReceiptKeys: open payments hold their receipts; an unassigned PAID payment\'s window is paid; the unrequested balance is held', () => {
  const credits = [
    cr('1', 1005, '2027-03-01T08:00:00'), cr('2', 2005, '2027-03-02T08:00:00'), // swept by PAID P1 (does not add up, no unique subset)
    cr('3', 3005, '2027-03-03T08:00:00'), // covered by REQUESTED P2
    cr('4', 4005, '2027-03-04T08:00:00'), // after the last payment
  ];
  const l = buildPaymentLedger(credits, [pay('P1', 9999, '2027-03-02T12:00:00'), pay('P2', 3005, '2027-03-03T12:00:00')]);
  assert.deepEqual(l.unassignedPayments.map(u => u.id), ['P1']);
  assert.deepEqual([...heldReceiptKeys(l, new Set(['P2']))].sort(), ['3', '4']);
});

test('uniqueSubset gives up (null) past the memo cap, and still finds the subset under the default cap', () => {
  assert.deepEqual(uniqueSubset([1, 2, 4, 8, 16], 31), [0, 1, 2, 3, 4]);
  assert.equal(uniqueSubset([1, 2, 4, 8, 16], 31, 2), null);
});

test('receiptCreditsOf keeps Receipt rows only and reads amounts', () => {
  const rows = receiptCreditsOf([
    { type: 'Receipt', reference_id: 'R-101', amount: '858.05', created_dt: '2027-03-01T09:00:00' },
    { type: 'Payment', reference_id: 'P-9', amount: '-858.05', created_dt: '2027-03-01T10:00:00' },
    { type: 'Receipt', reference_id: 'R-102', amount: 0.05, created_dt: '2027-03-01T09:30:00' },
    { type: 'Receipt', reference_id: 'R-103', amount: 'x', created_dt: '2027-03-01T09:30:00' },
  ]);
  assert.deepEqual(rows.map(r => [r.receiptId, r.cents]), [['101', 85805], ['102', 5]]);
});

test('sweep: each payment covers the credits since the previous request, a $0.05-only receipt included', () => {
  const credits = [
    cr('1', 85805, '2027-03-01T08:00:00'), cr('2', 35205, '2027-03-01T09:00:00'),
    cr('3', 5, '2027-03-05T08:00:00'), cr('4', 5405, '2027-03-05T09:00:00'), cr('5', 60005, '2027-03-06T09:00:00'),
  ];
  const l = buildPaymentLedger(credits, [pay('PA', 121010, '2027-03-01T12:00:00'), pay('PB', 65415, '2027-03-06T12:00:00')]);
  assert.deepEqual(l.byPayment.get('PA'), ['1', '2']);
  assert.deepEqual(l.byPayment.get('PB'), ['3', '4', '5']);
  assert.deepEqual([l.unassignedPayments, l.unassignedReceipts, l.afterLastPayment], [[], [], []]);
});

test('credits after the last payment are the unrequested balance; a REQUESTED payment is in byPayment', () => {
  const credits = [cr('1', 10005, '2027-03-01T08:00:00'), cr('2', 20005, '2027-03-02T08:00:00')];
  const l = buildPaymentLedger(credits, [pay('PA', 10005, '2027-03-01T12:00:00')]);
  assert.deepEqual(l.byPayment.get('PA'), ['1']);
  assert.deepEqual(l.afterLastPayment, ['2']);
  assert.deepEqual(l.unassignedReceipts, ['2']);
});

test('exact-subset fallback: window does not add up, but one subset of earlier credits does', () => {
  // credit 1 was swept into nothing we know; the window (2) plus the older credit 1 is the payment
  const credits = [cr('1', 30005, '2027-03-01T08:00:00'), cr('2', 70005, '2027-03-03T08:00:00'), cr('3', 9905, '2027-03-02T08:00:00')];
  const l = buildPaymentLedger(credits, [pay('PA', 100010, '2027-03-03T12:00:00')]);
  assert.deepEqual([...(l.byPayment.get('PA') ?? [])].sort(), ['1', '2']);
  assert.deepEqual(l.unassignedReceipts, ['3']);
});

test('ambiguous or impossible: left unassigned and reported, never guessed', () => {
  const ambiguous = [cr('1', 10005, '2027-03-01T08:00:00'), cr('2', 10005, '2027-03-01T09:00:00'), cr('3', 5, '2027-03-02T08:00:00'), cr('4', 7, '2027-03-02T09:00:00')];
  // 100.10 = 1+2? no: window (all four) sums 200.22; subsets reaching 100.05 are {1} or {2}
  const a = buildPaymentLedger(ambiguous, [pay('PA', 10005, '2027-03-02T12:00:00')]);
  assert.equal(a.byPayment.size, 0);
  assert.equal(a.unassignedPayments[0].id, 'PA');
  assert.deepEqual(a.unassignedPayments[0].windowReceipts.sort(), ['1', '2', '3', '4']);
  const none = buildPaymentLedger([cr('1', 10005, '2027-03-01T08:00:00')], [pay('PA', 12345, '2027-03-02T12:00:00')]);
  assert.deepEqual([none.byPayment.size, none.unassignedPayments.length, none.unassignedReceipts], [0, 1, ['1']]);
});

test('an unassigned payment does not stop later payments from using their own window', () => {
  const credits = [cr('1', 11111, '2027-03-01T08:00:00'), cr('2', 20005, '2027-03-05T08:00:00')];
  const l = buildPaymentLedger(credits, [pay('PA', 99999, '2027-03-02T12:00:00'), pay('PB', 20005, '2027-03-06T12:00:00')]);
  assert.deepEqual(l.byPayment.get('PB'), ['2']);
  assert.deepEqual(l.unassignedPayments.map(u => u.id), ['PA']);
});

test('orderCentsOfReceipts: per-order cents carry the 5 cent reward and add up to the payment; unknown receipts give null', () => {
  const orders = [
    { id: 1, orderNumber: '111-0000001', salePrice: 100, bgExpectedPayout: 100, trackingNumbers: null, buyer: null },
    { id: 2, orderNumber: '111-0000002', salePrice: 50, bgExpectedPayout: 50, trackingNumbers: null, buyer: null },
  ];
  const rcpt = (id: string, order: string, total: number) => [id, { receipt_id: id, order_number: order, total, paid: true, status: 'paid' }] as const;
  const byKey = new Map<string, unknown>([rcpt('1', '1110000001', 100), rcpt('2', '1110000002', 50), rcpt('3', '1110000002', 0)]);
  const cents = new Map([['1', 10005], ['2', 5005], ['3', 5]]);
  const m = orderCentsOfReceipts(['1', '2', '3'], byKey, cents, orders)!;
  assert.deepEqual([...m].sort(), [[1, 10005], [2, 5010]]);
  assert.equal(orderCentsOfReceipts(['1', '9'], byKey, cents, orders), null);
  assert.equal(orderCentsOfReceipts(['1'], byKey, new Map([['1', 19999]]), orders), null); // not a few cents over its total
});
