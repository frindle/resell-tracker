import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore node:sqlite has no types in this repo's @types/node
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

import { ORIGINAL_FROM, rateEntryOn, ratesOn, dayKey, todayKey, currentRateTarget, type RateEntry } from './cardRates.ts';
import { computeCashback } from './cashback.ts';
import { calcStats, calcMiles, type OrderForStats } from './analytics.ts';

// Synthetic card: 1x points until the boundary, 2x from it.
const BOUNDARY = '2026-06-01';
const HISTORY: RateEntry[] = [
  { effectiveFrom: ORIGINAL_FROM, rewardsRate: null, basePointsPerDollar: 1 },
  { effectiveFrom: BOUNDARY, rewardsRate: null, basePointsPerDollar: 2 },
];
const CARD = { milesProgram: 'Test Points', basePointsPerDollar: 2, merchantRates: [], rateHistory: HISTORY };

test('the rate before, on and after the boundary date', () => {
  assert.equal(ratesOn(CARD, '2026-05-31').basePointsPerDollar, 1);
  assert.equal(ratesOn(CARD, '2026-06-01').basePointsPerDollar, 2);
  assert.equal(ratesOn(CARD, '2026-06-02').basePointsPerDollar, 2);
  assert.equal(ratesOn(CARD, '1999-01-01').basePointsPerDollar, 1);
  // A stored order date (date-only UTC midnight and a real timestamp) lands on its calendar day.
  assert.equal(ratesOn(CARD, new Date('2026-05-31T00:00:00.000Z')).basePointsPerDollar, 1);
  assert.equal(ratesOn(CARD, new Date('2026-06-01T00:00:00.000Z')).basePointsPerDollar, 2);
});

test('a card with no history falls back to its own columns', () => {
  const c = { rewardsRate: 3, basePointsPerDollar: null };
  assert.deepEqual(ratesOn(c, '2026-01-01'), { rewardsRate: 3, basePointsPerDollar: null });
  assert.equal(rateEntryOn([], '2026-01-01'), null);
});

test('entries are picked by date, not by the order they are listed in', () => {
  const shuffled = [HISTORY[1], HISTORY[0]];
  assert.equal(ratesOn({ rateHistory: shuffled }, '2026-05-31').basePointsPerDollar, 1);
});

test('orders before the change keep their old cashback', () => {
  const card = { rewardsRate: 5, basePointsPerDollar: null, rateHistory: [
    { effectiveFrom: ORIGINAL_FROM, rewardsRate: 2, basePointsPerDollar: null },
    { effectiveFrom: BOUNDARY, rewardsRate: 5, basePointsPerDollar: null },
  ] };
  const cb = (d: string) => computeCashback(100, 0, 0, ratesOn(card, d).rewardsRate ?? 0);
  assert.equal(cb('2026-05-31'), 2);
  assert.equal(cb('2026-06-01'), 5);
});

function order(over: Partial<OrderForStats>): OrderForStats {
  return { salePrice: null, cost: 100, shippingCost: 0, insuranceCost: 0, returnedCost: 0, cashbackAmount: 0, portalCashback: null, amexOfferDollars: null, amexOfferPoints: null, platform: 'Amazon', card: CARD, ...over };
}

test('points follow the order date, and analytics totals add up across the boundary', () => {
  const before = order({ orderDate: '2026-05-31T12:00:00.000Z' });
  const after = order({ orderDate: '2026-06-02T12:00:00.000Z' });
  assert.equal(calcMiles(before), 100);
  assert.equal(calcMiles(after), 200);
  assert.equal(calcStats([before]).miles, 100);
  assert.equal(calcStats([before, after]).miles, 300);
  assert.equal(calcStats([before, after]).milesByProgram['Test Points'], 300);
});

test('migration: every card gets its current rate as the first entry, so past numbers do not change', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE "CreditCard" ("id" INTEGER PRIMARY KEY, "rewardsRate" REAL, "basePointsPerDollar" REAL)');
  db.exec('INSERT INTO "CreditCard" VALUES (1, 2, NULL), (2, NULL, 1.5), (3, NULL, NULL)');
  db.exec(readFileSync(new URL('../prisma/migrations/20261128000000_card_rate_history/migration.sql', import.meta.url), 'utf8'));
  const cards = db.prepare('SELECT * FROM "CreditCard" ORDER BY id').all() as { id: number; rewardsRate: number | null; basePointsPerDollar: number | null }[];
  const hist = db.prepare('SELECT * FROM "CardRateHistory"').all() as (RateEntry & { cardId: number })[];
  assert.equal(hist.length, cards.length);
  for (const c of cards) {
    const mine = hist.filter(h => h.cardId === c.id);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].effectiveFrom, ORIGINAL_FROM);
    // Any order date, old or new, resolves to exactly the card's own rate.
    for (const d of ['1990-01-01', '2020-02-29', '2026-11-19']) {
      assert.deepEqual(ratesOn({ rateHistory: mine }, d), { rewardsRate: c.rewardsRate, basePointsPerDollar: c.basePointsPerDollar });
    }
  }
});

test('dayKey is the Pacific day whatever zone the process runs in, with a boundary-day check', () => {
  // 18:00 PDT on 2026-05-31 is already 2026-06-01 in UTC: the server must still say 05-31.
  assert.equal(dayKey(new Date('2026-06-01T01:00:00.000Z')), '2026-05-31');
  assert.equal(dayKey('2026-06-01T01:00:00.000Z'), '2026-05-31');
  assert.equal(dayKey(new Date('2026-06-01T06:59:59.000Z')), '2026-05-31');
  assert.equal(dayKey(new Date('2026-06-01T07:00:00.000Z')), '2026-06-01');
  // Standard time: the day rolls at 08:00Z.
  assert.equal(dayKey(new Date('2026-12-02T07:59:00.000Z')), '2026-12-01');
  assert.equal(dayKey(new Date('2026-12-02T08:00:00.000Z')), '2026-12-02');
  // Date-only values keep their own day; plain strings pass through.
  assert.equal(dayKey(new Date('2026-06-01T00:00:00.000Z')), '2026-06-01');
  assert.equal(dayKey('2026-06-01'), '2026-06-01');
  assert.equal(dayKey(new Date('nope')), '');
});

test('an order at 18:00 PT the day before a boundary gets the old rate', () => {
  assert.equal(ratesOn(CARD, new Date('2026-06-01T01:00:00.000Z')).basePointsPerDollar, 1);
  assert.equal(ratesOn(CARD, new Date('2026-06-01T07:00:00.000Z')).basePointsPerDollar, 2);
});

test('todayKey is the Pacific day', () => {
  assert.equal(todayKey(new Date('2026-06-02T03:00:00.000Z')), '2026-06-01');
  assert.equal(todayKey(new Date('2026-06-02T07:00:00.000Z')), '2026-06-02');
});

test('a plain card edit adds today\'s entry and never rewrites older ones', () => {
  const orig: RateEntry = { effectiveFrom: ORIGINAL_FROM, rewardsRate: 2, basePointsPerDollar: null };
  assert.equal(currentRateTarget([orig], 5, null, '2026-07-10'), '2026-07-10');
  // Same-day second edit replaces today's entry.
  const today: RateEntry = { effectiveFrom: '2026-07-10', rewardsRate: 5, basePointsPerDollar: null };
  assert.equal(currentRateTarget([orig, today], 6, null, '2026-07-10'), '2026-07-10');
  // Unchanged rate: no write.
  assert.equal(currentRateTarget([orig], 2, null, '2026-07-10'), null);
  // No history: the original entry. Original that never held a rate: filled in.
  assert.equal(currentRateTarget([], 3, null, '2026-07-10'), ORIGINAL_FROM);
  assert.equal(currentRateTarget([{ effectiveFrom: ORIGINAL_FROM, rewardsRate: null, basePointsPerDollar: null }], 3, null, '2026-07-10'), ORIGINAL_FROM);
});

test('after a plain edit, an old order still resolves to the original rate', () => {
  const orig: RateEntry = { effectiveFrom: ORIGINAL_FROM, rewardsRate: 2, basePointsPerDollar: null };
  const target = currentRateTarget([orig], 5, null, '2026-07-10')!;
  const history = [orig, { effectiveFrom: target, rewardsRate: 5, basePointsPerDollar: null }];
  assert.equal(ratesOn({ rateHistory: history }, '2026-07-09').rewardsRate, 2);
  assert.equal(ratesOn({ rateHistory: history }, '2026-07-10').rewardsRate, 5);
});
