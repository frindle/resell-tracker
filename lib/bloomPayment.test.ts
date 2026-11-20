import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allocate, matchDeposit, paymentView, requestStatus, parseWithdrawals, runPayments, addManualRequest, requestDay,
  type CopyRow, type Deposit, type InvoiceRecord, type LedgerWithdrawal, type NewRequest, type PaymentRequest, type PaymentStore,
} from './bloomPayment.ts';

// All figures and dates are synthetic.
const inv = (month: string, gross: number, fees: number): InvoiceRecord =>
  ({ month, hash: `h-${month}`, grossCents: gross, feesCents: fees, payload: JSON.stringify({ month, invoiceId: `BL-${month}`, grossCents: gross, feesCents: fees, final: true }) });
const dep = (txnId: number, date: string, cents: number): Deposit => ({ txnId, date, cents });
const lw = (key: string, requestedAt: string, amountCents: number, refundedAt: string | null = null): LedgerWithdrawal =>
  ({ key, requestedAt, amountCents, status: refundedAt ? 'refunded' : 'requested', refundedAt });

function mem(invoices: InvoiceRecord[], deposits: Deposit[]) {
  const copies: (CopyRow & { createdAt: number })[] = [];
  const requests: PaymentRequest[] = [];
  let tick = 0;
  const find = (id: number) => requests.find(x => x.id === id)!;
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
    async setRefunded(_u, id, at) { find(id).refundedAt = at; },
    async setSent(_u, id, d, c, t) { const r = find(id); r.sentDate = d; r.sentCents = c; r.sentTxnId = t; },
    async clearSent(_u, id) { const r = find(id); r.sentDate = null; r.sentCents = null; r.sentTxnId = null; },
    async deposits() { return deposits; },
  };
  return { store, copies, requests };
}

test('FIFO: oldest deposits fill invoices in month order, each up to its payout', () => {
  const a = allocate(
    [inv('2030-02', 11_000, 1_000), inv('2030-01', 21_000, 1_000), inv('2030-03', 6_000, 0)],      // payouts: Jan 20000, Feb 10000, Mar 6000
    [dep(3, '2030-02-20', 9_000), dep(1, '2030-01-10', 12_000), dep(2, '2030-01-28', 5_000), dep(4, '2030-03-05', 4_000)]);
  const jan = a.get('2030-01')!, feb = a.get('2030-02')!, mar = a.get('2030-03')!;
  assert.deepEqual([jan.allocatedCents, jan.dueCents, jan.status], [17_000, 3_000, 'part_paid']);   // 12000 + 5000, still 3000 short
  assert.deepEqual(jan.covering.map(c => [c.txnId, c.cents]), [[1, 12_000], [2, 5_000]]);
  assert.deepEqual([feb.allocatedCents, feb.dueCents, feb.status], [9_000, 1_000, 'part_paid']);    // Feb takes the Feb-20 deposit only, Mar deposit waits behind it
  assert.deepEqual(mar.covering.map(c => [c.txnId, c.cents]), [[4, 4_000]]);
  assert.deepEqual([mar.dueCents, mar.status], [2_000, 'part_paid']);
  // a deposit bigger than what is left of a month spills into the next
  const spill = allocate([inv('2030-01', 5_000, 0), inv('2030-02', 5_000, 0)], [dep(1, '2030-01-05', 7_000)]);
  assert.deepEqual([spill.get('2030-01')!.status, spill.get('2030-02')!.allocatedCents, spill.get('2030-02')!.dueCents, spill.get('2030-02')!.status], ['paid', 2_000, 3_000, 'part_paid']);
  assert.equal(allocate([inv('2030-01', 5_000, 0)], []).get('2030-01')!.status, 'due');
  assert.equal(allocate([inv('2030-01', 1_000, 1_000)], [dep(1, '2030-01-05', 700)]).get('2030-01')!.status, 'nothing_due');
});

test('early money waits for the next invoice and is allocated when that invoice appears', async () => {
  const invoices = [inv('2030-01', 11_000, 1_000)];
  const deposits = [dep(1, '2030-01-31', 10_000), dep(2, '2030-02-10', 4_000)];
  const { store, copies } = mem(invoices, deposits);
  await runPayments(store, 1, null);
  assert.equal(allocate(invoices, deposits).get('2030-01')!.allocatedCents, 10_000);   // January takes its 10000; the 4000 waits
  assert.equal(JSON.parse(copies.find(c => c.copy === 2)!.payload).payment.status, 'paid');
  invoices.push(inv('2030-02', 8_000, 0));
  const feb = allocate(invoices, deposits).get('2030-02')!;
  assert.deepEqual([feb.allocatedCents, feb.dueCents, feb.status], [4_000, 4_000, 'part_paid']);
  await runPayments(store, 1, null);
  assert.deepEqual(copies.filter(c => c.month === '2030-02').map(c => c.copy), [1]);   // copy 1 shows the due at that moment
  assert.equal(JSON.parse(copies.find(c => c.month === '2030-02')!.payload).payment.dueCents, 4_000);
});

test('a refunded request never matches a deposit and releases one it matched before', async () => {
  const { store, requests } = mem([inv('2030-01', 11_000, 1_000)], [dep(1, '2030-02-04', 10_000)]);
  await runPayments(store, 1, [lw('w-a', '2030-02-02T18:00:00Z', 10_000)]);
  assert.equal(requests[0].sentTxnId, 1);                                          // matched while it looked fine
  await runPayments(store, 1, [lw('w-a', '2030-02-02T18:00:00Z', 10_000, '2030-02-03T10:00:00Z')]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].refundedAt, '2030-02-03T10:00:00Z');
  assert.deepEqual([requests[0].sentDate, requests[0].sentCents, requests[0].sentTxnId], [null, null, null]);
  await runPayments(store, 1, [lw('w-a', '2030-02-02T18:00:00Z', 10_000, '2030-02-03T10:00:00Z')]);
  assert.equal(requests[0].sentTxnId, null);                                       // and it does not match again
  assert.equal(matchDeposit({ requestedAt: '2030-02-02', requestedCents: 10_000, refundedAt: '2030-02-03' }, [dep(1, '2030-02-04', 10_000)], new Set()), null);
  assert.equal(requestStatus(requests[0], '2030-02-04'), 'refunded');
});

test('a retry after a refund matches the deposit', async () => {
  const { store, requests } = mem([inv('2030-01', 25_000, 0)], [dep(9, '2030-02-08', 12_500)]);
  await runPayments(store, 1, [lw('w-a', '2030-02-02T18:00:00Z', 10_000, '2030-02-03T09:00:00Z'), lw('w-b', '2030-02-04T18:00:00Z', 12_500)]);
  assert.deepEqual(requests.map(r => [r.ledgerKey, r.sentTxnId]), [['w-a', null], ['w-b', 9]]);
  assert.equal(requests[1].sentDate, '2030-02-08');
});

test('several requests in one month each match their own deposit', async () => {
  const { store, requests } = mem([inv('2030-01', 40_000, 0)],
    [dep(1, '2030-02-04', 10_000), dep(2, '2030-02-11', 10_000), dep(3, '2030-02-20', 9_000)]);
  await runPayments(store, 1, [lw('a', '2030-02-02T18:00:00Z', 10_000), lw('b', '2030-02-09T18:00:00Z', 10_000), lw('c', '2030-02-18T18:00:00Z', 9_050)]);
  assert.deepEqual(requests.map(r => [r.ledgerKey, r.sentTxnId]), [['a', 1], ['b', 2], ['c', 3]]);
});

test('copy 2 is written once when due hits 0, with covering deposits and their requests, and is never rewritten', async () => {
  const invoices = [inv('2030-01', 22_000, 1_000)];                                // payout 21000
  const deposits: Deposit[] = [dep(1, '2030-02-04', 6_000)];
  const { store, copies, requests } = mem(invoices, deposits);
  const w = [lw('a', '2030-02-02T18:00:00Z', 6_000), lw('b', '2030-02-09T18:00:00Z', 15_000)];
  const a = await runPayments(store, 1, w);
  assert.deepEqual([a.copy1, a.copy2, a.matched], [1, 0, 1]);
  const c1 = copies[0].payload;
  assert.equal(JSON.parse(c1).payment.dueCents, 21_000);                           // due when first stored
  deposits.push(dep(2, '2030-02-12', 15_000));
  const b = await runPayments(store, 1, w);
  assert.deepEqual([b.copy1, b.copy2, b.matched], [0, 1, 1]);
  assert.deepEqual(copies.map(c => c.copy), [1, 2]);
  assert.equal(copies[0].payload, c1, 'copy 1 is never edited');
  const p2 = JSON.parse(copies[1].payload);
  assert.equal(p2.copy, 2); assert.equal(p2.finalCopy, true);
  assert.deepEqual(p2.payment.deposits, [{ date: '2030-02-04', cents: 6_000, requestedAt: '2030-02-02T18:00:00Z' }, { date: '2030-02-12', cents: 15_000, requestedAt: '2030-02-09T18:00:00Z' }]);
  assert.equal(p2.payment.sentDate, '2030-02-12');
  assert.equal(requests.length, 2);
  const c2 = copies[1].payload;
  deposits.push(dep(3, '2030-02-15', 500));                                        // later money changes nothing already written
  const c = await runPayments(store, 1, w);
  assert.deepEqual([c.copy1, c.copy2, c.requests], [0, 0, 0]);
  assert.equal(copies[1].payload, c2);
  const view = paymentView(invoices, deposits, copies, requests, '2030-03-01');
  assert.deepEqual([view.months[0].status, view.months[0].dueCents, view.months[0].sentDate, view.months[0].copies.map(x => x.copy)], ['paid', 0, '2030-02-12', [1, 2]]);
});

test('a request older than 7 days with no deposit is flagged; refunded and sent are not', () => {
  const r = (over: Partial<PaymentRequest> = {}): PaymentRequest => ({ id: 1, source: 'detected', ledgerKey: 'k', requestedAt: '2030-02-03T15:00:00Z', requestedCents: 5, refundedAt: null, sentDate: null, sentCents: null, sentTxnId: null, ...over });
  assert.equal(requestStatus(r(), '2030-02-10'), 'pending');
  assert.equal(requestStatus(r(), '2030-02-11'), 'flagged');
  assert.equal(requestStatus(r({ sentDate: '2030-02-08' }), '2030-03-30'), 'sent');
  assert.equal(requestStatus(r({ refundedAt: '2030-02-04T00:00:00Z' }), '2030-03-30'), 'refunded');
  const v = paymentView([], [], [], [r(), r({ id: 2, requestedAt: '2030-02-09T00:00:00Z', refundedAt: '2030-02-10T00:00:00Z' })], '2030-02-20');
  assert.deepEqual(v.requests.map(x => x.status), ['refunded', 'flagged']);
});

test('deposit matching: window, tolerance, closest amount, each deposit used once', () => {
  const req = { requestedAt: '2030-02-03T15:00:00Z', requestedCents: 10_000 };
  const deps = [dep(1, '2030-02-02', 10_000), dep(2, '2030-02-06', 10_090), dep(3, '2030-02-07', 10_000), dep(4, '2030-02-20', 10_000), dep(5, '2030-02-05', 10_500)];
  assert.equal(matchDeposit(req, deps, new Set())?.txnId, 3);          // exact beats 90 cents off; before the request day and after the window are out
  assert.equal(matchDeposit(req, deps, new Set([3]))?.txnId, 2);       // within the larger of $1 and 1%
  assert.equal(matchDeposit(req, deps, new Set([3, 2])), null);        // $5 off is not a match
  assert.equal(matchDeposit({ requestedAt: '2030-02-03', requestedCents: 1_000_000 }, [dep(9, '2030-02-05', 1_009_999)], new Set())?.txnId, 9); // 1% of $10,000
  assert.equal(requestDay('not a date'), null);
  assert.equal(requestDay('2030-02-01T03:00:00Z'), '2030-01-31');     // Los Angeles time
});

test('malformed ledger rows are dropped; an unknown or missing status is treated as requested', () => {
  const ok = { key: 'w-1', requested_at: '2030-02-03T00:00:00Z', since: 'x', amount_cents: 700 };
  const got = parseWithdrawals({ withdrawals: [
    ok, { ...ok, key: '' }, { ...ok, amount_cents: -5 }, { ...ok, amount_cents: 1.5 }, { ...ok, requested_at: 'nope' }, 7,
    { ...ok, key: 'w-2', status: 'sent?!' },
    { ...ok, key: 'w-3', status: 'refunded', refunded_at: '2030-02-04T00:00:00Z' },
    { ...ok, key: 'w-4', status: 'refunded' },
  ] });
  assert.deepEqual(got.map(g => [g.key, g.status, g.refundedAt]), [
    ['w-1', 'requested', null], ['w-2', 'requested', null], ['w-3', 'refunded', '2030-02-04T00:00:00Z'], ['w-4', 'refunded', '2030-02-03T00:00:00Z'],
  ]);
  assert.throws(() => parseWithdrawals({}));
});

test('a re-run with the same ledger answer stores each key once', async () => {
  const { store, requests } = mem([inv('2030-01', 11_000, 1_000)], []);
  const w = [lw('a', '2030-02-02T20:00:00Z', 10_000)];
  assert.equal((await runPayments(store, 1, w)).requests, 1);
  assert.equal((await runPayments(store, 1, w)).requests, 0);
  assert.equal(requests.length, 1);
});

test('manual request: validated, any number per day or month, matched like a detected one', async () => {
  const { store, requests, copies } = mem([inv('2030-01', 11_000, 1_000)], [dep(7, '2030-02-05', 10_000)]);
  const bad = (o: object) => addManualRequest(store, 1, { requestedAt: '2030-02-02', requestedCents: 10_000, ...o });
  assert.equal((await bad({ requestedAt: '02/02/2030' }) as { status: number }).status, 400);
  assert.equal((await bad({ requestedCents: 0 }) as { status: number }).status, 400);
  assert.equal((await bad({ requestedCents: 1.5 }) as { status: number }).status, 400);
  const ok = await bad({});
  assert.ok('ok' in ok && ok.ok.source === 'manual');
  assert.equal(requests[0].sentTxnId, 7);                                           // the deposit was already there
  assert.ok('ok' in await bad({}));                                                 // a second request the same month is fine
  assert.equal(requests.length, 2);
  assert.deepEqual(copies.map(c => c.copy), [1, 2]);                                // the deposit pays the month in full
});
