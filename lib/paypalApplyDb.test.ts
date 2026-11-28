import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPayments, type PayPalDb } from './paypalApplyDb.ts';
import type { HeldEmail, PaymentEmail } from './emailAutoImportPlan.ts';

// Synthetic fixtures only.
const NOW = Date.parse('2026-11-15T20:00:00Z');
const quiet = { log: () => {}, error: () => {} };
const payment: PaymentEmail = {
  id: 'm:p', userId: 1, date: '2026-11-15T19:00:00Z',
  receipt: { merchant: 'Example Store Inc', amount: 123.45, date: '2026-11-15', network: 'Visa', last4: '4242', txnId: 'ABCDE12345FGHIJ67', orderRef: '' },
};

function fakeDb(order: Record<string, unknown>) {
  const updates: { id: number; data: Record<string, unknown> }[] = [];
  const db = {
    order: {
      findMany: async () => [{
        id: 5, platform: 'Example Store', orderNumber: 'EX-1000001', cost: 123.45, taxAmount: null, shippingCost: 0,
        orderDate: new Date('2026-11-15T00:00:00Z'), createdAt: new Date('2026-11-15T00:00:00Z'), notes: null,
        cancelled: false, cardId: null, locked: false, cashbackAmount: 0, noRushBonusPercent: null, ...order,
      }],
      update: async (args: { where: { id: number }; data: Record<string, unknown> }) => { updates.push({ id: args.where.id, data: args.data }); },
    },
    creditCard: {
      findMany: async () => [{ id: 10, last4: '4242', lastFours: [], rewardsRate: 2, excludeShippingFromCashback: false, rateHistory: [] }],
    },
  } as unknown as PayPalDb;
  return { db, updates };
}

test('a card set from a receipt also earns cashback at the card rate, and the books are refreshed', async () => {
  const { db, updates } = fakeDb({});
  const held: HeldEmail[] = [];
  const refreshed: number[] = [];
  const done = await applyPayments(db, [payment], held, NOW, quiet, uid => { refreshed.push(uid); });
  assert.deepEqual(done, ['m:p']);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].data.cardId, 10);
  assert.equal(updates[0].data.cashbackAmount, 2.47);
  assert.deepEqual(refreshed, [1]);
});

test('cashback already on the order is left alone, and a receipt that writes nothing refreshes nothing', async () => {
  const keep = fakeDb({ cashbackAmount: 9.99 });
  const refreshed: number[] = [];
  await applyPayments(keep.db, [payment], [], NOW, quiet, uid => { refreshed.push(uid); });
  assert.equal(keep.updates[0].data.cardId, 10);
  assert.equal('cashbackAmount' in keep.updates[0].data, false);

  // Waiting for an order that does not match: held, nothing written.
  const none = fakeDb({ cost: 500 });
  const held: HeldEmail[] = [];
  const other: number[] = [];
  await applyPayments(none.db, [payment], held, NOW, quiet, uid => { other.push(uid); });
  assert.equal(none.updates.length, 0);
  assert.deepEqual(other, []);
  assert.equal(held.length, 1);
});

test('a card the order already has (no card set) writes no cashback', async () => {
  const { db, updates } = fakeDb({ cardId: 10 });
  await applyPayments(db, [payment], [], NOW, quiet);
  assert.equal('cashbackAmount' in updates[0].data, false);
  assert.equal('cardId' in updates[0].data, false);
});
