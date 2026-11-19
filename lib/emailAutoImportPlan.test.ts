import test from 'node:test';
import assert from 'node:assert/strict';
import { planAutoImport, parseMissLine, heldSummary, needsAttention, trackingNudgeText, cancelAction, cancelFillsItem, cancelNoteText, WAIT_FOR_ORDER_MS, type PlanContext } from './emailAutoImportPlan.ts';
import type { ParsedEmailOrder } from './emailMessage.ts';

const NOW = Date.parse('2026-11-15T20:00:00Z');

function email(over: Partial<ParsedEmailOrder>): ParsedEmailOrder {
  return {
    uid: 'm:x', messageId: '<x@test>', subject: 'Ordered', from: 'auto-confirm@amazon.com', date: '2026-11-15T19:00:00Z',
    platform: 'Amazon', kind: 'ordered', forwarded: false, orderNumber: '111-2223334-4445556', itemDescription: 'Widget',
    cost: 50, shippingAddress: '', trackingNumbers: [], recipients: ['sam@orders.example.test'], senders: ['auto-confirm@amazon.com'], rawSnippet: '',
    ...over,
  };
}

function ctx(over: Partial<PlanContext> = {}): PlanContext {
  return {
    rules: [{ userId: 1, pattern: 'sam@orders.example.test' }, { userId: 2, pattern: 'kim@orders.example.test' }],
    onlyUserId: null,
    knownOrders: () => new Set(),
    shippingRules: () => [],
    now: NOW,
    ...over,
  };
}

test('an order email for one user is imported for that user', () => {
  const plan = planAutoImport([email({ uid: 'm:a' })], ctx());
  assert.equal(plan.held.length, 0);
  assert.deepEqual([...plan.users.keys()], [1]);
  const b = plan.users.get(1)!;
  assert.deepEqual(b.ids, ['m:a']);
  assert.equal(b.inputs[0].kind, 'ordered');
  assert.equal(b.inputs[0].cost, 50);
  assert.equal(b.inputs[0].cardId, '');
  assert.equal(b.noTotal, 0);
});

test('emails go to the user their address belongs to', () => {
  const plan = planAutoImport([
    email({ uid: 'm:a' }),
    email({ uid: 'm:b', orderNumber: '222-0000000-0000000', recipients: ['kim@orders.example.test'] }),
  ], ctx());
  assert.deepEqual(plan.users.get(1)!.ids, ['m:a']);
  assert.deepEqual(plan.users.get(2)!.ids, ['m:b']);
});

test('unclaimed and doubly claimed emails wait for a person', () => {
  const plan = planAutoImport([
    email({ uid: 'm:a', recipients: ['someone@else.test'], senders: ['x@y.test'] }),
    email({ uid: 'm:b', recipients: ['sam@orders.example.test', 'kim@orders.example.test'] }),
  ], ctx());
  assert.equal(plan.users.size, 0);
  assert.deepEqual(plan.held.map(h => [h.id, h.reason, h.userId]), [['m:a', 'unassigned', null], ['m:b', 'ambiguous', null]]);
});

test('with one user every email is theirs', () => {
  const plan = planAutoImport([email({ uid: 'm:a', recipients: ['someone@else.test'] })], ctx({ onlyUserId: 1 }));
  assert.deepEqual(plan.users.get(1)!.ids, ['m:a']);
});

test('refunds, other mail, emails without an order number and early cancellations are left alone', () => {
  const plan = planAutoImport([
    email({ uid: 'm:c', kind: 'cancelled' }),
    email({ uid: 'm:r', kind: 'refund' }),
    email({ uid: 'm:o', kind: 'other' }),
    email({ uid: 'm:n', orderNumber: '' }),
  ], ctx());
  assert.equal(plan.users.size, 0);
  // A cancellation waits for its order like a shipping note does.
  assert.deepEqual(plan.held.map(h => [h.id, h.reason]), [['m:r', 'needs-review'], ['m:o', 'needs-review'], ['m:n', 'no-order-number'], ['m:c', 'waiting-for-order']]);
  assert.deepEqual(plan.cancels, []);
});

test('a cancellation for a known order, or one ordered in the same run, is a cancel', () => {
  const known = planAutoImport([email({ uid: 'm:c', kind: 'cancelled', cost: 0, cancel: { amount: 0, whole: true } })],
    ctx({ knownOrders: () => new Set(['11122233344445556']) }));
  assert.equal(known.held.length, 0);
  assert.equal(known.users.size, 0);
  assert.deepEqual(known.cancels, [{ id: 'm:c', userId: 1, platform: 'Amazon', order: '11122233344445556', amount: 0, whole: true, item: 'Widget' }]);

  const same = planAutoImport([email({ uid: 'm:o' }), email({ uid: 'm:c', kind: 'cancelled', cancel: { amount: 50, whole: false } })], ctx());
  assert.deepEqual(same.users.get(1)!.ids, ['m:o']);
  assert.equal(same.cancels[0].amount, 50);
});

test('cancelAction: whole orders only, never a locked one', () => {
  const o = { id: 7, cost: 898, cancelled: false, locked: false };
  assert.equal(cancelAction({ amount: 0, whole: true }, o), 'cancel');
  // Walmart says "Some items were canceled" for all of them; the amount decides.
  assert.equal(cancelAction({ amount: 898, whole: false }, o), 'cancel');
  assert.equal(cancelAction({ amount: 429, whole: false }, o), 'partial-cancel');
  assert.equal(cancelAction({ amount: 0, whole: false }, o), 'partial-cancel');
  assert.equal(cancelAction({ amount: 898, whole: false }, { ...o, cost: 0 }), 'partial-cancel');
  assert.equal(cancelAction({ amount: 0, whole: true }, { ...o, locked: true }), 'locked-order');
  assert.equal(cancelAction({ amount: 0, whole: true }, { ...o, cancelled: true, locked: true }), 'already-cancelled');
  assert.equal(cancelAction({ amount: 0, whole: true }, undefined), 'no-matching-order');
});

test('cancelNoteText: tracker ids and released units, no retailer order numbers', () => {
  const text = cancelNoteText([
    { platform: 'Amazon', orderId: 1025, wasCost: 1199.98, released: [{ group: 'BFMR', name: 'Console', quantity: 2 }] },
    { platform: 'Walmart', orderId: 1057, wasCost: null, released: [{ group: 'BigSky', name: 'Laptop', quantity: 2 }] },
  ]);
  assert.equal(text, [
    'Amazon cancelled order #1025 (was $1199.98): marked cancelled.',
    '  Released BFMR: 2× Console (still open on BFMR: reorder or cancel it there)',
    'Order #1057 was already cancelled: released what it still held.',
    '  Released BigSky: 2× Laptop',
  ].join('\n'));
  const bfmr = (b: { cancelled: number; left: string[] }) => cancelNoteText([{ platform: 'Amazon', orderId: 1, wasCost: 10, released: [{ group: 'BFMR', name: 'Console', quantity: 1 }], bfmr: b }]).split('\n')[1];
  assert.equal(bfmr({ cancelled: 1, left: [] }), '  Released BFMR: 1× Console (cancelled on BFMR too)');
  assert.equal(bfmr({ cancelled: 0, left: ['it is shipped on BFMR'] }), '  Released BFMR: 1× Console (left open on BFMR: it is shipped on BFMR. Cancel it there)');
  assert.equal(bfmr({ cancelled: 1, left: ['x', 'x'] }), '  Released BFMR: 1× Console (1 cancelled on BFMR, 2 left open: x)');
});

test('a shipping note waits for its order, then is flagged after two days', () => {
  const ship = { kind: 'shipped' as const, trackingNumbers: ['1Z999AA10123456784'], cost: 0 };
  const fresh = planAutoImport([email({ uid: 'm:s', ...ship })], ctx());
  assert.equal(fresh.users.size, 0);
  assert.equal(fresh.held[0].reason, 'waiting-for-order');
  assert.equal(needsAttention(fresh.held[0].reason), false);

  const old = planAutoImport([email({ uid: 'm:s', ...ship, date: new Date(NOW - WAIT_FOR_ORDER_MS - 1000).toISOString() })], ctx());
  assert.equal(old.held[0].reason, 'no-matching-order');
  assert.equal(needsAttention(old.held[0].reason), true);

  const undated = planAutoImport([email({ uid: 'm:s', ...ship, date: '' })], ctx());
  assert.equal(undated.held[0].reason, 'no-matching-order');
});

test('a shipping note imports when the order exists or its order email is in the same batch', () => {
  const ship = email({ uid: 'm:s', kind: 'shipped', cost: 0, trackingNumbers: ['1Z999AA10123456784'], orderNumber: '111 2223334 4445556' });
  const known = planAutoImport([ship], ctx({ knownOrders: uid => new Set(uid === 1 ? ['11122233344445556'] : []) }));
  assert.deepEqual(known.users.get(1)!.ids, ['m:s']);

  const same = planAutoImport([email({ uid: 'm:o' }), ship], ctx());
  assert.deepEqual(same.users.get(1)!.ids, ['m:o', 'm:s']);

  // Another user's order with that number does not count.
  const other = planAutoImport([ship], ctx({ knownOrders: uid => new Set(uid === 2 ? ['11122233344445556'] : []) }));
  assert.equal(other.held[0].reason, 'waiting-for-order');
});

test('buyer comes from the user\'s shipping rules; a confirmed store imports under its name; missing totals are counted', () => {
  const plan = planAutoImport([email({ uid: 'm:a', platform: 'Unknown', from: 'Shop Co <orders@mail.shopco.test>', cost: 0, shippingAddress: '100 Test St, Springfield ZZ 00001' })],
    ctx({ shippingRules: uid => (uid === 1 ? [{ pattern: '00001', buyerId: 7 }] : []), learnedMerchants: [{ domain: 'shopco.test', name: 'Shop Co' }] }));
  const b = plan.users.get(1)!;
  assert.equal(b.inputs[0].buyerId, '7');
  assert.equal(b.inputs[0].platform, 'Shop Co');
  assert.equal(b.noTotal, 1);
});

test('the first email from a store the tracker does not know waits for a person', () => {
  const plan = planAutoImport([email({ uid: 'm:n', platform: 'Unknown', from: 'Shop Co <orders@mail.shopco.test>' })], ctx());
  assert.equal(plan.users.size, 0);
  assert.deepEqual(plan.held, [{ id: 'm:n', userId: 1, platform: 'Unknown', kind: 'ordered', reason: 'new-store' }]);
  assert.ok(needsAttention('new-store'));
  assert.match(heldSummary(plan.held), /new store/);
});

test('a shipping email with no tracking number in it is noted for the tracking nudge', () => {
  const plan = planAutoImport([
    email({ uid: 'm:o' }),
    email({ uid: 'm:s', kind: 'shipped', trackingNumbers: [] }),
    email({ uid: 'm:t', kind: 'shipped', orderNumber: '111-0000000-0000001', trackingNumbers: ['1Z999AA10123456784'] }),
  ], ctx({ knownOrders: () => new Set(['11100000000000001']) }));
  assert.deepEqual(plan.shippedNoTracking, [{ id: 'm:s', userId: 1, platform: 'Amazon', order: '11122233344445556' }]);
  assert.equal(plan.users.get(1)!.ids.length, 3);
});

test('log lines and alerts carry no order numbers, addresses or titles', () => {
  const plan = planAutoImport([email({ uid: 'm:c', kind: 'refund', shippingAddress: '100 Test St', itemDescription: 'Secret Widget' })], ctx());
  const line = parseMissLine(plan.held[0]);
  assert.equal(line, '[email-parse-miss] platform=Amazon kind=refund reason=needs-review user=1');
  const text = heldSummary([...plan.held, ...plan.held]);
  assert.match(text, /^2 order emails need a look/);
  assert.match(text, /2× Amazon refund/);
  for (const s of [line, text]) {
    assert.doesNotMatch(s, /111|Test St|Secret/);
  }
});

test('a PayPal receipt goes to the payments list, not to the import or the held list', () => {
  const receipt = { merchant: 'Example Store Inc', amount: 123.45, date: '2026-11-15', network: 'Visa', last4: '4242', txnId: 'ABCDE12345FGHIJ67', orderRef: '' };
  const plan = planAutoImport([email({ uid: 'm:p', kind: 'payment', platform: 'Unknown', from: 'service@paypal.example.com', orderNumber: '', payment: receipt })], ctx());
  assert.deepEqual(plan.payments, [{ id: 'm:p', userId: 1, receipt, date: '2026-11-15T19:00:00Z' }]);
  assert.equal(plan.users.size, 0);
  assert.deepEqual(plan.held, []);
});

test('a PayPal receipt nobody claims is held as unassigned like any other email', () => {
  const receipt = { merchant: 'Example Store Inc', amount: 5, date: '', network: null, last4: null, txnId: 'ABCDE12345FGHIJ67', orderRef: '' };
  const plan = planAutoImport([email({ uid: 'm:p', kind: 'payment', platform: 'Unknown', recipients: ['nobody@orders.example.test'], senders: [], payment: receipt })], ctx());
  assert.equal(plan.payments.length, 0);
  assert.equal(plan.held[0].reason, 'unassigned');
});

test('a payment-kind email with no receipt data still waits for a person', () => {
  const plan = planAutoImport([email({ uid: 'm:p', kind: 'payment', platform: 'Unknown', orderNumber: '' })], ctx());
  assert.equal(plan.payments.length, 0);
  assert.equal(plan.held[0].reason, 'needs-review');
});

test('tracking nudge: Amazon points at Track package, other stores at the order page', () => {
  assert.equal(trackingNudgeText([{ platform: 'Amazon' }, { platform: 'Amazon' }, { platform: 'Lenovo' }]),
    "2 Amazon orders shipped. Amazon's email has no tracking number: open the order on Amazon (Track package) and add it.\n"
    + '1 Lenovo order shipped, but the email had no tracking number. Check the order page.');
});

test('a shipment email covering several orders imports each order with its own tracking', () => {
  const known = new Set(['11100000010000001', '11100000020000002']);
  const plan = planAutoImport([email({
    uid: 'm:multi', kind: 'shipped', orderNumber: '111-0000001-0000001', itemDescription: 'Electronics (1 items)', cost: 0,
    extraOrders: [{ orderNumber: '111-0000002-0000002', itemDescription: 'Toys (2 items)', trackingNumbers: ['TBA000000000001'] }],
  })], ctx({ knownOrders: () => known }));
  const b = plan.users.get(1)!;
  assert.deepEqual(b.ids, ['m:multi']);
  assert.deepEqual(b.inputs.map(i => [i.orderNumber, i.itemDescription, i.trackingNumbers]), [
    ['111-0000001-0000001', 'Electronics (1 items)', []],
    ['111-0000002-0000002', 'Toys (2 items)', ['TBA000000000001']],
  ]);
});

test('a multi-order shipment waits when any of its orders is not in the tracker yet', () => {
  const plan = planAutoImport([email({
    uid: 'm:multi', kind: 'shipped', orderNumber: '111-0000001-0000001',
    extraOrders: [{ orderNumber: '111-0000002-0000002', itemDescription: '', trackingNumbers: [] }],
  })], ctx({ knownOrders: () => new Set(['11100000010000001']) }));
  assert.equal(plan.users.size, 0);
  assert.deepEqual(plan.held.map(h => h.reason), ['waiting-for-order']);
});

test('a cancellation carries the item the email names', () => {
  const plan = planAutoImport([email({ uid: 'm:c', kind: 'cancelled', itemDescription: 'Acme Laptop (+1 more)', cancel: { amount: 10, whole: true } })],
    ctx({ knownOrders: () => new Set(['11122233344445556']) }));
  assert.equal(plan.cancels[0].item, 'Acme Laptop (+1 more)');
});

test('a BuyingGroup receipt email is a receipt, not an import, hold or cancel', () => {
  const plan = planAutoImport([email({ uid: 'm:r', platform: 'BuyingGroup', kind: 'other', orderNumber: '', recipients: [], bgReceipt: { receiptId: 'R-1', trackingNumbers: ['1Z000000000000001'] } })], ctx());
  assert.deepEqual(plan.receipts, [{ id: 'm:r', receiptId: 'R-1', trackingNumbers: ['1Z000000000000001'] }]);
  assert.equal(plan.users.size, 0);
  assert.equal(plan.held.length, 0);
  assert.equal(plan.cancels.length, 0);
});
