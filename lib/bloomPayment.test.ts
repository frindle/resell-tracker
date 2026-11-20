import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  amountDue, matchDeposit, monthOfRequest, paymentRows, paymentStatus, parseWithdrawals, runPayments, addManualRequest, requestDay,
  type CopyRow, type Deposit, type InvoiceRecord, type PaymentRequest, type PaymentStore, type NewRequest,
} from './bloomPayment.ts';

// All figures and dates are synthetic.
const inv = (month: string, gross: number, fees: number): InvoiceRecord =>
  ({ month, hash: `h-${month}`, grossCents: gross, feesCents: fees, payload: JSON.stringify({ month, invoiceId: `BL-${month}`, grossCents: gross, feesCents: fees, final: true }) });
const dep = (txnId: number, date: string, cents: number): Deposit => ({ txnId, date, cents });

function mem(invoices: InvoiceRecord[], deposits: Deposit[]) {
  const copies: (CopyRow & { createdAt: number })[] = [];
  const requests: PaymentRequest[] = [];
  let tick = 0;
  const store: PaymentStore = {
    async invoices() { return invoices; },
    async copies() { return copies; },
    async addCopy(_u, row) {
      if (copies.some(c => c.month === row.month && c.copy === row.copy)) return false;
      copies.push({ ...row, createdAt: ++tick });
      return true;
    },
    async requests() { return requests.map(r => ({ ...r })); },
    async addRequest(_u, r: NewRequest) { const x = { ...r, id: requests.length + 1, sentDate: null, sentCents: null, sentTxnId: null }; requests.push(x); return { ...x }; },
    async setSent(_u, id, d, c, t) { const r = requests.find(x => x.id === id)!; r.sentDate = d; r.sentCents = c; r.sentTxnId = t; },
    async deposits() { return deposits; },
  };
  return { store, copies, requests };
}

test('due = invoice payout minus the Darkbloom deposits that landed in the month; zero or less is nothing due', () => {
  const i = inv('2030-01', 21_000 + 1_000, 1_000);   // payout 21000
  assert.deepEqual(amountDue(i, [dep(1, '2030-01-10', 6_000), dep(2, '2030-01-28', 4_000), dep(3, '2030-02-02', 9_999)]),
    { payoutCents: 21_000, depositsCents: 10_000, dueCents: 11_000, nothingDue: false });
  const none = amountDue(i, [dep(1, '2030-01-10', 21_000)]);
  assert.equal(none.nothingDue, true); assert.equal(none.dueCents, 0);
  const over = amountDue(i, [dep(1, '2030-01-10', 25_000)]);
  assert.equal(over.nothingDue, true); assert.equal(over.dueCents, 0);
});

test('a request belongs to the month before the day it was made, in Los Angeles time', () => {
  assert.equal(monthOfRequest('2030-02-03T15:00:00Z'), '2030-01');
  assert.equal(monthOfRequest('2030-02-01T03:00:00Z'), '2029-12');   // 19:00 on Jan 31 in LA: still January, so December's invoice
  assert.equal(monthOfRequest('2030-01-05'), '2029-12');
  assert.equal(requestDay('not a date'), null);
});

test('deposit matching: window, tolerance, closest amount, each deposit used once', () => {
  const req = { requestedAt: '2030-02-03T15:00:00Z', requestedCents: 10_000 };
  const deps = [dep(1, '2030-02-02', 10_000), dep(2, '2030-02-06', 10_090), dep(3, '2030-02-07', 10_000), dep(4, '2030-02-20', 10_000), dep(5, '2030-02-05', 10_500)];
  assert.equal(matchDeposit(req, deps, new Set())?.txnId, 3);          // exact beats 90 cents off; before the request day and after the window are out
  assert.equal(matchDeposit(req, deps, new Set([3]))?.txnId, 2);       // within the larger of $1 and 1%
  assert.equal(matchDeposit(req, deps, new Set([3, 2])), null);        // $5 off is not a match
  assert.equal(matchDeposit({ requestedAt: '2030-02-03', requestedCents: 1_000_000 }, [dep(9, '2030-02-05', 1_009_999)], new Set())?.txnId, 9); // 1% of $10,000
});

test('status: unmatched is flagged only after the flag days', () => {
  const r = (over: Partial<PaymentRequest> = {}): PaymentRequest => ({ id: 1, month: '2030-01', source: 'detected', ledgerKey: 'k', requestedAt: '2030-02-03T15:00:00Z', requestedCents: 5, sentDate: null, sentCents: null, sentTxnId: null, ...over });
  assert.equal(paymentStatus({ nothingDue: false }, r(), '2030-02-10'), 'requested');
  assert.equal(paymentStatus({ nothingDue: false }, r(), '2030-02-11'), 'unmatched');
  assert.equal(paymentStatus({ nothingDue: false }, r({ sentDate: '2030-02-08' }), '2030-03-30'), 'sent');
  assert.equal(paymentStatus({ nothingDue: false }, null, '2030-02-02'), 'not_requested');
  assert.equal(paymentStatus({ nothingDue: true }, null, '2030-02-02'), 'nothing_due');
});

test('parseWithdrawals drops malformed rows and refuses a non-list', () => {
  const ok = { key: 'w-1', requested_at: '2030-02-03T00:00:00Z', since: 'x', amount_cents: 700 };
  assert.deepEqual(parseWithdrawals({ withdrawals: [ok, { ...ok, key: '' }, { ...ok, amount_cents: -5 }, { ...ok, amount_cents: 1.5 }, { ...ok, requested_at: 'nope' }, 7] }),
    [{ key: 'w-1', requestedAt: '2030-02-03T00:00:00Z', amountCents: 700 }]);
  assert.throws(() => parseWithdrawals({}));
});

test('full pass: copy 1 at once, request recorded, copy 2 only when the payment matches; both kept; a re-run changes nothing', async () => {
  const { store, copies, requests } = mem([inv('2030-01', 22_000, 1_000)], [dep(1, '2030-01-15', 6_000)]);
  const w = [{ key: 'w-a', requestedAt: '2030-02-02T18:00:00Z', amountCents: 15_000 }];
  const a = await runPayments(store, 1, w);
  assert.deepEqual([a.copy1, a.requests, a.matched, a.copy2], [1, 1, 0, 0]);
  assert.equal(copies.length, 1);
  const c1 = copies[0].payload;
  assert.equal(JSON.parse(c1).payment.dueCents, 15_000);
  assert.equal(JSON.parse(c1).copy, 1);

  // the deposit shows up four days later (a new bank row); the earlier ones are untouched
  const later = mem([inv('2030-01', 22_000, 1_000)], [dep(1, '2030-01-15', 6_000), dep(2, '2030-02-06', 15_000)]);
  await later.store.addCopy(1, copies[0]); await later.store.addRequest(1, requests[0]);
  const b = await runPayments(later.store, 1, w);
  assert.deepEqual([b.copy1, b.requests, b.matched, b.copy2], [0, 0, 1, 1]);
  assert.deepEqual(later.copies.map(c => c.copy), [1, 2]);
  assert.equal(later.copies[0].payload, c1, 'copy 1 is never edited');
  const p2 = JSON.parse(later.copies[1].payload);
  assert.equal(p2.copy, 2); assert.equal(p2.finalCopy, true);
  assert.deepEqual(p2.payment.sent, { date: '2030-02-06', cents: 15_000 });
  assert.equal(p2.payment.requested.day, '2030-02-02');
  const c2 = later.copies[1].payload;
  const c = await runPayments(later.store, 1, w);
  assert.deepEqual([c.copy1, c.requests, c.matched, c.copy2], [0, 0, 0, 0]);
  assert.equal(later.copies[1].payload, c2);
  const rows = paymentRows(later.copies, later.requests, '2030-03-01');
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].status, rows[0].flagged, rows[0].dueCents, rows[0].sent?.date, rows[0].copies.map(x => x.copy)], ['sent', false, 15_000, '2030-02-06', [1, 2]]);
});

test('requests that do not belong are ignored: no invoice yet, nothing due, a month that already has one', async () => {
  const { store, requests } = mem([inv('2030-01', 11_000, 1_000), inv('2030-02', 5_000, 0)], [dep(1, '2030-02-10', 5_000)]);
  const r = await runPayments(store, 1, [
    { key: 'a', requestedAt: '2030-02-02T20:00:00Z', amountCents: 10_000 },   // January: recorded
    { key: 'b', requestedAt: '2030-02-20T20:00:00Z', amountCents: 400 },      // January again: ignored
    { key: 'c', requestedAt: '2030-03-02T20:00:00Z', amountCents: 5_000 },    // February is paid in full: nothing due, ignored
    { key: 'd', requestedAt: '2030-04-02T20:00:00Z', amountCents: 5_000 },    // March has no invoice: ignored (retried on a later run)
  ]);
  assert.equal(r.requests, 1);
  assert.deepEqual(requests.map(x => [x.month, x.ledgerKey]), [['2030-01', 'a']]);
});

test('unmatched request: no copy 2, row flagged after the days', async () => {
  const { store, copies, requests } = mem([inv('2030-01', 11_000, 1_000)], []);
  await runPayments(store, 1, [{ key: 'a', requestedAt: '2030-02-02T20:00:00Z', amountCents: 10_000 }]);
  assert.equal(copies.length, 1);
  assert.equal(paymentRows(copies, requests, '2030-02-05')[0].flagged, false);
  assert.equal(paymentRows(copies, requests, '2030-02-12')[0].flagged, true);
});

test('manual request: validated, one per month, matched like a detected one', async () => {
  const { store, copies } = mem([inv('2030-01', 11_000, 1_000)], [dep(7, '2030-02-05', 10_000)]);
  await runPayments(store, 1, null);
  assert.equal(copies.length, 1);
  const bad = (o: object) => addManualRequest(store, 1, { month: '2030-01', requestedAt: '2030-02-02', requestedCents: 10_000, ...o });
  assert.equal((await bad({ month: '2030-13' }) as { status: number }).status, 400);
  assert.equal((await bad({ requestedAt: '2030-01-30' }) as { status: number }).status, 400);   // before the month ended
  assert.equal((await bad({ requestedCents: 0 }) as { status: number }).status, 400);
  assert.equal((await bad({ month: '2030-03', requestedAt: '2030-04-02' }) as { status: number }).status, 404);
  const ok = await bad({});
  assert.ok('ok' in ok && ok.ok.source === 'manual');
  assert.deepEqual(copies.map(c => c.copy), [1, 2]);                // the deposit was already there, so it matched at once
  assert.equal((await bad({}) as { status: number }).status, 409);
});

test('nothing due: copy 1 says so and is final; no request is taken', async () => {
  const { store, copies } = mem([inv('2030-01', 11_000, 1_000)], [dep(1, '2030-01-20', 10_000)]);
  await runPayments(store, 1, [{ key: 'a', requestedAt: '2030-02-02T20:00:00Z', amountCents: 10_000 }]);
  const p = JSON.parse(copies[0].payload);
  assert.equal(p.payment.nothingDue, true); assert.equal(p.finalCopy, true);
  assert.equal(paymentRows(copies, [], '2030-02-03')[0].status, 'nothing_due');
});
