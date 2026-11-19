import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBgReceipt, unmatchedReceipts, shouldRunReceiptSync, freshAlerts, alertKey, receiptAlertText, normTracking, BG_RECEIPT_DEBOUNCE_MS,
  planReceiptFailure, receiptSyncOutcome, dueUserFailAlerts, BG_USER_FAIL_ALERT_MS, userSyncFailText,
  afterReceiptFailure, NO_RECEIPT_FAILURES, BG_RECEIPT_BACKOFF_MS, BG_RECEIPT_MAX_FAILURES, BG_RECEIPT_GIVE_UP_MS } from './bgReceiptEmail.ts';
import { parseRawOrderEmail } from './emailMessage.ts';

// Synthetic: made-up names, ids and numbers.
const SUBJECT = 'Enclosed is your RECEIPT - ID R-0000000001 from buyinggroup.com';
const BODY = [
  'Hello Sam Example,', 'We have received your order.', 'ORDER DETAILS',
  'Receipt ID: R-0000000001', 'Tracking #: 1Z000000000000001', 'Date: 11/17/2026', 'Status: VERIFIED',
  'ITEMS', 'acme laptop 15', 'UPC: 000000000000', 'Qty: 3', 'Commitment: CM-0000000001', 'Price: $295.00', 'Total: $885.00',
].join('\n');

test('parseBgReceipt reads the id and tracking', () => {
  assert.deepEqual(parseBgReceipt(SUBJECT, BODY), { receiptId: 'R-0000000001', trackingNumbers: ['1Z000000000000001'] });
  assert.equal(parseBgReceipt('Your order has shipped', BODY), null);
  assert.deepEqual(parseBgReceipt(SUBJECT, 'Receipt ID: R-0000000001\n'), { receiptId: 'R-0000000001', trackingNumbers: [] });
});

test('unmatchedReceipts: tracking on any order matches, case and spacing aside', () => {
  const rs = [{ id: 'a', trackingNumbers: ['1Z000000000000001'] }, { id: 'b', trackingNumbers: ['1Z000000000000002'] }, { id: 'c', trackingNumbers: [] }];
  assert.deepEqual(unmatchedReceipts(rs, ['x, 1z-000000000000001', '']).map(r => r.id), ['b', 'c']);
  assert.equal(normTracking(' 1z-00 '), '1Z00');
});

test('debounce and once-per-receipt alerts', () => {
  assert.ok(shouldRunReceiptSync(1000, null));
  assert.ok(!shouldRunReceiptSync(1000 + BG_RECEIPT_DEBOUNCE_MS - 1, 1000));
  assert.ok(shouldRunReceiptSync(1000 + BG_RECEIPT_DEBOUNCE_MS, 1000));
  const rs = [{ receiptId: 'R-1' }, { receiptId: 'R-1' }, { receiptId: 'R-2' }];
  assert.deepEqual(freshAlerts(rs, [alertKey('fail', 'R-2')], 'fail').map(r => r.receiptId), ['R-1']);
  assert.equal(freshAlerts(rs, [alertKey('fail', 'R-2')], 'nomatch').length, 2);
  assert.match(receiptAlertText('nomatch', ['R-1', 'R-1']), /^BuyingGroup receipt R-1:/);
});

function mime(subject: string, from: string, body: string) {
  return ['From: Support <' + from + '>', 'To: sam@orders.example.test', 'Subject: ' + subject, 'Date: Tue, 17 Nov 2026 08:52:00 -0800',
    'Message-ID: <r1@example.test>', 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', body, ''].join('\r\n');
}

test('receipt mail is never a store order: null unless the caller asks, then a receipt only', async () => {
  const raw = mime(SUBJECT, 'support@buyinggroup.com', BODY);
  assert.equal(await parseRawOrderEmail(raw, 'k', { shared: true }), null);
  const r = await parseRawOrderEmail(raw, 'k', { shared: true, bgReceipts: true });
  assert.ok(r);
  assert.equal(r.orderNumber, '');
  assert.equal(r.kind, 'other');
  assert.deepEqual(r.bgReceipt, { receiptId: 'R-0000000001', trackingNumbers: ['1Z000000000000001'] });
  // other buying-group mail stays out even when receipts are asked for
  assert.equal(await parseRawOrderEmail(mime('Your Commitment Has Been Affected', 'support@buyinggroup.com', 'Order #1234567890'), 'k', { shared: true, bgReceipts: true }), null);
});

test('receipt sync failures back off, then give up after N failures or 24h', () => {
  let st = NO_RECEIPT_FAILURES;
  const first = afterReceiptFailure(st, 1000);
  assert.equal(first.giveUp, false);
  assert.equal(first.state.retryAt, 1000 + BG_RECEIPT_BACKOFF_MS);
  st = first.state;
  for (let i = 2; i < BG_RECEIPT_MAX_FAILURES; i++) { const n = afterReceiptFailure(st, 1000 + i); assert.equal(n.giveUp, false); st = n.state; }
  const last = afterReceiptFailure(st, 2000);
  assert.equal(last.giveUp, true);
  assert.deepEqual(last.state, NO_RECEIPT_FAILURES);
  const old = afterReceiptFailure({ failures: 1, firstAt: 0, retryAt: 0 }, BG_RECEIPT_GIVE_UP_MS);
  assert.equal(old.giveUp, true);
});

test('receiptSyncOutcome: one user failing while another synced counts as done', () => {
  assert.equal(receiptSyncOutcome({ failed: 0, synced: 2, failedUserIds: [] }), 'ok');
  assert.equal(receiptSyncOutcome({ failed: 0, synced: 0, failedUserIds: [] }), 'ok');
  assert.equal(receiptSyncOutcome({ failed: 1, synced: 1, failedUserIds: [2] }), 'partial');
  assert.equal(receiptSyncOutcome({ failed: 1, synced: 0, failedUserIds: [2] }), 'failed');
  // A fatal error (no user id) is a failed run even if some user synced first.
  assert.equal(receiptSyncOutcome({ failed: 2, synced: 1, failedUserIds: [2] }), 'failed');
  assert.equal(receiptSyncOutcome({ failed: 1, synced: 0, failedUserIds: [] }), 'failed');
});

test('a failing user is told once a day, in their own words', () => {
  const last = new Map<number, number>();
  assert.deepEqual(dueUserFailAlerts([2, 3], last, 1000), [2, 3]);
  last.set(2, 1000);
  assert.deepEqual(dueUserFailAlerts([2, 3], last, 1000 + BG_USER_FAIL_ALERT_MS - 1), [3]);
  assert.deepEqual(dueUserFailAlerts([2], last, 1000 + BG_USER_FAIL_ALERT_MS), [2]);
  assert.match(userSyncFailText(), /Your BuyingGroup receipt sync is failing/);
});

test('planReceiptFailure: backs off, names fresh receipts, then names every receipt when giving up', () => {
  const rs = [{ receiptId: 'R-0000000001' }, { receiptId: 'R-0000000002' }];
  const first = planReceiptFailure(rs, [], NO_RECEIPT_FAILURES, 1000, []);
  assert.equal(first.giveUp, false);
  assert.equal(first.state.retryAt, 1000 + BG_RECEIPT_BACKOFF_MS);
  assert.deepEqual(first.newKeys, [alertKey('fail', 'R-0000000001'), alertKey('fail', 'R-0000000002')]);
  assert.equal(first.notices.length, 1);
  assert.equal(first.notices[0].to, 'all');
  assert.match(first.notices[0].text, /R-0000000001, R-0000000002/);
  // Already alerted and not giving up: nothing more to say.
  const again = planReceiptFailure(rs, first.newKeys, first.state, 2000, []);
  assert.equal(again.notices.length, 0);
  // Giving up: the receipt alerted on failure 1 is named as removed too, with only one new receipt.
  const rs3 = [...rs, { receiptId: 'R-0000000003' }];
  const last = planReceiptFailure(rs3, first.newKeys, { failures: BG_RECEIPT_MAX_FAILURES - 1, firstAt: 1000, retryAt: 0 }, 3000, [7]);
  assert.equal(last.giveUp, true);
  assert.deepEqual(last.state, NO_RECEIPT_FAILURES);
  assert.deepEqual(last.notices[0].to, [7]);
  assert.match(last.notices[0].text, /R-0000000001, R-0000000002, R-0000000003/);
  assert.match(last.notices[0].text, /removed/);
  assert.deepEqual(last.newKeys, [alertKey('fail', 'R-0000000003')]);
});
