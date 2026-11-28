import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateBatch, planBatch, type BatchCard } from './ccBatch.ts';
import type { BuyOrderRate } from './ccWaitlist.ts';

const rates: BuyOrderRate[] = [
  { id: 11, brandName: 'Acme Foods', value: 50, rate: 0.8, availableCap: 500 },
  { id: 12, brandName: 'Acme Foods', value: 50, rate: 0.85, availableCap: 500 },
  { id: 13, brandName: 'Acme Foods', value: 25, rate: 0.9, availableCap: 0 },
  { id: 14, brandName: 'Globex', value: 100, rate: 0.7, availableCap: 500 },
];
const card = (id: number, over: Partial<BatchCard> = {}): BatchCard => ({
  id, orderId: 1, merchant: 'Acme Foods', value: 50, ccSubmittedAt: null, needsReview: false, ...over,
});

test('groups by best-rate buy order and tracker order, totals face and payout', () => {
  const plan = planBatch([3, 1, 2, 4], [
    card(1), card(2), card(3, { orderId: 2 }), card(4, { merchant: 'Globex', value: 100 }),
  ], rates);
  assert.equal(plan.groups.length, 3);
  const acme1 = plan.groups.find(g => g.orderId === 1 && g.buyOrderId === 12)!;
  assert.deepEqual(acme1.cardIds, [1, 2]);
  assert.equal(acme1.payout, 85);
  assert.equal(plan.count, 4);
  assert.equal(plan.face, 250);
  assert.equal(plan.payout, 42.5 + 85 + 70);
  assert.deepEqual(plan.brands, ['Acme Foods', 'Globex']);
});

test('skips submitted, review, no-rate, unknown and dedupes repeats', () => {
  const plan = planBatch([1, 1, 2, 3, 4, 99], [
    card(1),
    card(2, { ccSubmittedAt: new Date('2026-01-01') }),
    card(3, { needsReview: true }),
    card(4, { value: 25 }), // only rate for $25 has no capacity
  ], rates);
  assert.deepEqual(plan.groups.map(g => g.cardIds), [[1]]);
  assert.deepEqual(plan.skipped, [
    { id: 2, reason: 'already_submitted' },
    { id: 3, reason: 'needs_review' },
    { id: 4, reason: 'no_rate' },
    { id: 99, reason: 'not_found' },
  ]);
});

test('aggregate reports submitted, failed with reason, and skipped per card', () => {
  const plan = planBatch([1, 2, 3, 4], [card(1), card(2), card(3, { merchant: 'Globex', value: 100 }), card(4, { ccSubmittedAt: new Date() })], rates);
  const [a, b] = plan.groups;
  const s = aggregateBatch(plan, [
    { group: a, submittedIds: [1] },
    { group: b, submittedIds: [], error: 'Reservation did not approve in time' },
  ]);
  assert.equal(s.submitted, 1);
  assert.equal(s.failed, 2);
  assert.equal(s.skipped, 1);
  assert.deepEqual(s.results.map(r => r.id), [1, 2, 3, 4]);
  assert.equal(s.results.find(r => r.id === 2)?.reason, 'Not submitted');
  assert.equal(s.results.find(r => r.id === 3)?.reason, 'Reservation did not approve in time');
  assert.equal(s.results.find(r => r.id === 4)?.status, 'skipped');
});
