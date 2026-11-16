import test from 'node:test';
import assert from 'node:assert/strict';
import { planAutoImport, parseMissLine, heldSummary, needsAttention, trackingNudgeText, WAIT_FOR_ORDER_MS, type PlanContext } from './emailAutoImportPlan.ts';
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

test('cancellations, refunds, other mail and emails without an order number are left alone', () => {
  const plan = planAutoImport([
    email({ uid: 'm:c', kind: 'cancelled' }),
    email({ uid: 'm:r', kind: 'refund' }),
    email({ uid: 'm:o', kind: 'other' }),
    email({ uid: 'm:n', orderNumber: '' }),
  ], ctx());
  assert.equal(plan.users.size, 0);
  assert.deepEqual(plan.held.map(h => [h.id, h.reason]), [['m:c', 'needs-review'], ['m:r', 'needs-review'], ['m:o', 'needs-review'], ['m:n', 'no-order-number']]);
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
  const plan = planAutoImport([email({ uid: 'm:c', kind: 'cancelled', shippingAddress: '100 Test St', itemDescription: 'Secret Widget' })], ctx());
  const line = parseMissLine(plan.held[0]);
  assert.equal(line, '[email-parse-miss] platform=Amazon kind=cancelled reason=needs-review user=1');
  const text = heldSummary([...plan.held, ...plan.held]);
  assert.match(text, /^2 order emails need a look/);
  assert.match(text, /2× Amazon cancelled/);
  for (const s of [line, text]) {
    assert.doesNotMatch(s, /111|Test St|Secret/);
  }
});

test('tracking nudge: Amazon points at Sync Amazon, other stores at the order page', () => {
  assert.equal(trackingNudgeText([{ platform: 'Amazon' }, { platform: 'Amazon' }, { platform: 'Lenovo' }]),
    "2 Amazon orders shipped. Amazon's email has no tracking number: click Sync Amazon on the Orders page (Firefox) to pull it.\n"
    + '1 Lenovo order shipped, but the email had no tracking number. Check the order page.');
});
