import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTask, classifyTask, matchTask, normalizeStatus, trackingKey, damageLabel } from './bgReturns.ts';

const damagedRaw = {
  key: 'fbb6bcc2-0000-0000-0000-000000000001',
  item: { key: 'i1', item_id: 'Widget-Pro-256-0001', item_serial: 'SN0000TEST01 - ', note: 'Damage - DAMAGED_ITEM - DAMAGED_ITEM', damage: true },
  barcode: '000000000001',
  receipt: { receipt_id: 'R-1000000001', tracking_id: '9400000000000000000001' },
  ticket_id: 'T-10000001', task_status: 'TICKET', void: false, discount: 0,
  created_dt: '11-28-2026, 19:20:42', updated_dt: '11-28-2026, 19:20:42',
};

test('parseTask: a damaged task keeps the damage flag, the item note and the discount', () => {
  const t = parseTask(damagedRaw)!;
  assert.equal(t.damaged, true);
  assert.equal(t.note, 'Damage - DAMAGED_ITEM - DAMAGED_ITEM');
  assert.equal(t.discount, 0);
  assert.equal(t.serial, 'SN0000TEST01');
  assert.equal(t.status, 'TICKET');
  assert.equal(t.supportId, 'T-10000001');
});

test('parseTask: an undamaged task has no damage and no note', () => {
  const t = parseTask({ ...damagedRaw, item: { ...damagedRaw.item, note: '', damage: false } })!;
  assert.equal(t.damaged, false);
  assert.equal(t.note, null);
});

test('parseTask: discount as a numeric string, and garbage', () => {
  assert.equal(parseTask({ ...damagedRaw, discount: '12.5' })!.discount, 12.5);
  assert.equal(parseTask({ ...damagedRaw, discount: 'abc' })!.discount, null);
  assert.equal(parseTask({ ...damagedRaw, discount: null })!.discount, null);
  assert.equal(parseTask({ ...damagedRaw, discount: {} })!.discount, null);
  assert.equal(parseTask({ ...damagedRaw, discount: Infinity })!.discount, null);
});

test('damageLabel: BG notes become short lower-case text', () => {
  assert.equal(damageLabel('Damage - DAMAGED_ITEM - DAMAGED_ITEM'), 'damaged item');
  assert.equal(damageLabel('Damage - MISSING_PARTS'), 'missing parts');
  assert.equal(damageLabel('Damage - DAMAGED_ITEM - MISSING_PARTS'), 'damaged item, missing parts');
  assert.equal(damageLabel('  box crushed  '), 'box crushed');
  assert.equal(damageLabel(null), null);
  assert.equal(damageLabel(''), null);
  assert.equal(damageLabel('   '), null);
});

test('classifyTask: a discount is shown as BG gives it, only when above 0', () => {
  const base = { status: 'ACCEPTED_WITH_DISCOUNT', voided: false, note: null };
  assert.deepEqual(classifyTask({ ...base, discount: 0 }), { kind: 'accepted', effect: 'Accepted with a discount: BG pays less than committed' });
  assert.deepEqual(classifyTask({ ...base, discount: 12.5 }), { kind: 'accepted', effect: 'Accepted with a discount: BG pays less than committed (BG discount: 12.5)' });
  assert.deepEqual(classifyTask(base), { kind: 'accepted', effect: 'Accepted with a discount: BG pays less than committed' });
  assert.deepEqual(classifyTask({ status: 'TICKET', voided: false, note: null, discount: 0 }), { kind: 'return', status: 'requested' });
});

const raw = {
  key: 'abc', task_status: 'ACCEPTED_WITHOUT_DISCOUNT', void: false, ticket_id: 'T-9', note: 'No Commitment - Accepted With 0% Discount',
  receipt: { receipt_id: 'R-123', tracking_id: '1Z999AA10123456784' }, item: { item_id: 'SKU1', item_serial: 'SN123 - ' },
  created_dt: '2026-11-01', updated_dt: '2026-11-02', images: ['a', 'b'],
};

test('parseTask: maps the get_tasks row, ignores a row with no key', () => {
  const t = parseTask(raw)!;
  assert.deepEqual([t.key, t.receiptId, t.sku, t.serial, t.status, t.supportId, t.tracking, t.imageCount], ['abc', 'R-123', 'SKU1', 'SN123', 'ACCEPTED_WITHOUT_DISCOUNT', 'T-9', '1Z999AA10123456784', 2]);
  assert.equal(parseTask({ task_status: 'READY' }), null);
  assert.equal(normalizeStatus('Accepted Without Discount'), 'ACCEPTED_WITHOUT_DISCOUNT');
});

test('classifyTask: accepted is not a return', () => {
  assert.equal(classifyTask({ status: 'ACCEPTED_WITHOUT_DISCOUNT', voided: false, note: null }).kind, 'accepted');
  assert.deepEqual(classifyTask({ status: 'READY', voided: false, note: null }), { kind: 'return', status: 'requested' });
  assert.deepEqual(classifyTask({ status: 'SENT', voided: false, note: null }), { kind: 'return', status: 'in_transit' });
  assert.equal(classifyTask({ status: 'READY', voided: true, note: null }).kind, 'void');
  assert.equal(classifyTask({ status: 'USER_CHANGED', voided: false, note: null }).kind, 'other');
});

test('matchTask: tracking first, then serial, then a SKU only one order has', () => {
  const orders = [{ id: 1, tracking: ['1Z999AA10123456784'], skus: ['A'] }, { id: 2, tracking: ['777'], skus: ['B'] }, { id: 3, tracking: [], skus: ['B'] }];
  assert.deepEqual(matchTask({ tracking: '1z999aa10123456784', serial: null, sku: null }, orders), { orderId: 1, by: 'tracking' });
  assert.deepEqual(matchTask({ tracking: null, serial: 'S1', sku: null }, orders, new Map([['S1', 2]])), { orderId: 2, by: 'serial' });
  assert.deepEqual(matchTask({ tracking: null, serial: null, sku: 'A' }, orders), { orderId: 1, by: 'sku' });
  assert.equal(matchTask({ tracking: null, serial: null, sku: 'B' }, orders), null); // two orders carry it
});

test('matchTask: two orders on one tracking are split by SKU, else no match', () => {
  const orders = [{ id: 1, tracking: ['123456789012'], skus: ['A'] }, { id: 2, tracking: ['123456789012'], skus: ['B'] }];
  assert.deepEqual(matchTask({ tracking: '123456789012', serial: null, sku: 'B' }, orders), { orderId: 2, by: 'tracking' });
  assert.equal(matchTask({ tracking: '123456789012', serial: null, sku: null }, orders), null);
  assert.equal(trackingKey('12'), null);
});

test('isUntouchedSyncRow: only a row the sync made and nobody edited', async () => {
  const { isUntouchedSyncRow } = await import('./bgReturns.ts');
  const base = { status: 'requested', refundAmount: null, returnTracking: null, notes: 'Auto-recorded from Buying Group returns: x', quantity: 1, receivedAt: null, refundedAt: null };
  assert.equal(isUntouchedSyncRow(base), true);
  for (const edit of [{ status: 'refunded' }, { status: 'rejected' }, { refundAmount: 5 }, { returnTracking: '1Z' }, { notes: 'mine' }, { notes: null }, { quantity: 2 }, { receivedAt: new Date() }]) {
    assert.equal(isUntouchedSyncRow({ ...base, ...edit }), false, JSON.stringify(edit));
  }
});
