import test from 'node:test';
import assert from 'node:assert/strict';
import { lockedOrderFill } from './lockedOrderFill.ts';

const RANK: Record<string, number> = { shipped: 3, 'pkg received': 4, processed: 4, paid: 5 };
const rank = (s: string | null | undefined) => (s ? RANK[s] ?? 0 : 0);
const order900 = { bgPaidAmount: null, bfmrReceived: false, bfmrStatus: 'shipped', overdueAt: null };

test('order 900: locked, every leg now paid -> payment and status fill in', () => {
  assert.deepEqual(
    lockedOrderFill(order900, { bgPaidAmount: 2524, bfmrReceived: true, bfmrStatus: 'paid', salePrice: 2600, bgExpectedPayout: 2600, locked: true }, rank),
    { bgPaidAmount: 2524, bfmrReceived: true, bfmrStatus: 'paid' },
  );
});

test('confirmed values on a locked order are never overwritten', () => {
  const paid = { bgPaidAmount: 295.79, bfmrReceived: true, bfmrStatus: 'paid', overdueAt: null };
  assert.deepEqual(lockedOrderFill(paid, { bgPaidAmount: 444.78, salePrice: 444.78, bfmrStatus: 'processed' }, rank), {});
  assert.deepEqual(lockedOrderFill(order900, { bgPaidAmount: 0 }, rank), {});
});

test('overdue clears only when the sync clears it', () => {
  const od = { ...order900, overdueAt: new Date() };
  assert.deepEqual(lockedOrderFill(od, { overdueAt: null }, rank), { overdueAt: null });
  assert.deepEqual(lockedOrderFill(od, { overdueAt: new Date() }, rank), {});
});
