// Adversarial repo-style test for: rt-ccwaitlist-cases   (node --test / tsx --test)
//
// Pins the money-costing properties of lib/ccWaitlist.ts:
//  - deadline is INCLUSIVE and checked BEFORE the rate;
//  - rate test is >= (exact hit submits, a hair under waits);
//  - WAIT fires neither hook; throwing hooks record one {id,message} error and
//    the run continues; bare-string throws stay readable;
//  - brand matching: case-insensitive bidirectional substring after trim +
//    whitespace collapse ('Best Buy' ~ 'best buy ', NOT 'BestBuy');
//  - denomination within a cent; availableCap <= 0 rows skipped, not fatal;
//  - highest rate wins, lowest id breaks ties; empty list -> null;
//  - no usable rate: may EXPIRE, never SUBMIT.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  decideWaitlist,
  runWaitlist,
  pickCurrentRate,
  planWaitlistRun,
} from './lib/ccWaitlist.ts';

const card = (over: Partial<{ id: string | number; targetRate: number; maxDate: string }> = {}) => ({
  id: 'c1',
  targetRate: 0.85,
  maxDate: '2026-03-01',
  ...over,
});

const rateRow = (over: Partial<{ id: number; brandName: string; value: number; rate: number; availableCap: number }> = {}) => ({
  id: 1,
  brandName: 'Best Buy',
  value: 50,
  rate: 0.85,
  availableCap: 10,
  ...over,
});

// --- decideWaitlist --------------------------------------------------------

test('deadline is INCLUSIVE: today === maxDate still decides on the rate', () => {
  assert.equal(decideWaitlist(card(), 0.9, '2026-03-01'), 'SUBMIT');
  assert.equal(decideWaitlist(card(), 0.84, '2026-03-01'), 'WAIT');
});

test('today > maxDate expires even when the rate is far above target', () => {
  assert.equal(decideWaitlist(card(), 0.99, '2026-03-02'), 'EXPIRE');
  assert.equal(decideWaitlist(card({ targetRate: 0.5 }), 1.0, '2026-03-02'), 'EXPIRE');
});

test('rate test is >=: exact hit submits, a hair under waits', () => {
  assert.equal(decideWaitlist(card(), 0.85, '2026-02-15'), 'SUBMIT');
  assert.equal(decideWaitlist(card(), 0.8499, '2026-02-15'), 'WAIT');
});

// --- runWaitlist -----------------------------------------------------------

test('runWaitlist: WAIT fires neither hook; summary buckets are correct', async () => {
  const calls: string[] = [];
  const hooks = {
    submit: (c) => { calls.push(`submit:${c.id}`); },
    onExpire: (c) => { calls.push(`expire:${c.id}`); },
  };
  const s = await runWaitlist(
    [card({ id: 's' }), card({ id: 'w', targetRate: 0.99 }), card({ id: 'e', maxDate: '2026-01-01' })],
    0.85,
    '2026-02-15',
    hooks,
  );
  assert.deepEqual(s.submitted, ['s']);
  assert.deepEqual(s.waiting, ['w']);
  assert.deepEqual(s.expired, ['e']);
  assert.deepEqual(s.errors, []);
  assert.deepEqual(calls, ['submit:s', 'expire:e']); // WAIT fired nothing
});

test('runWaitlist: a throwing submit hook records exactly one {id,message} error and the run continues', async () => {
  const hooks = {
    submit: (c) => { if (c.id === 'boom') throw new Error('gateway down'); },
    onExpire: () => {},
  };
  const s = await runWaitlist(
    [card({ id: 'ok1' }), card({ id: 'boom' }), card({ id: 'ok2' })],
    0.9,
    '2026-02-15',
    hooks,
  );
  assert.deepEqual(s.submitted, ['ok1', 'ok2']); // boom NOT counted as submitted
  assert.equal(s.waiting.length, 0);
  assert.equal(s.expired.length, 0);            // ... and not expired either
  assert.deepEqual(s.errors, [{ id: 'boom', message: 'gateway down' }]);
});

test('runWaitlist: a throwing onExpire hook is recorded the same way; bare-string throws stay readable', async () => {
  const hooks = {
    submit: () => {},
    onExpire: (c) => { if (c.id === 'x1') throw new Error('db lock'); if (c.id === 'x2') throw 'raw string failure'; },
  };
  const s = await runWaitlist(
    [card({ id: 'x1', maxDate: '2026-01-01' }), card({ id: 'x2', maxDate: '2026-01-01' })],
    0.85,
    '2026-02-15',
    hooks,
  );
  assert.equal(s.expired.length, 0); // neither counted as expired
  assert.deepEqual(s.errors, [
    { id: 'x1', message: 'db lock' },
    { id: 'x2', message: 'raw string failure' },
  ]);
});

// --- pickCurrentRate -------------------------------------------------------

test('pickCurrentRate: brand match is case-insensitive bidirectional substring after trim + whitespace collapse', () => {
  const c = { merchant: 'Best Buy', value: 50 };
  assert.equal(pickCurrentRate(c, [rateRow({ brandName: 'best buy ' })]).id, 1);
  // collapsed internal whitespace on the card side too
  assert.equal(pickCurrentRate({ merchant: '  best   BUY ', value: 50 }, [rateRow()]).id, 1);
  // bidirectional: a longer brand name containing the row's brand also matches
  assert.equal(pickCurrentRate({ merchant: 'Best Buy Rewards', value: 50 }, [rateRow()]).id, 1);
});

test('pickCurrentRate: "BestBuy" does NOT match "Best Buy"', () => {
  const r = pickCurrentRate({ merchant: 'BestBuy', value: 50 }, [rateRow()]);
  assert.equal(r, null);
});

test('pickCurrentRate: denomination must match within a cent', () => {
  const rows = [rateRow({ id: 1, value: 50 }), rateRow({ id: 2, value: 50.01 })];
  assert.equal(pickCurrentRate({ merchant: 'Best Buy', value: 50 }, rows).id, 1);
  assert.equal(pickCurrentRate({ merchant: 'Best Buy', value: 50.02 }, rows).id, 2); // |50.02-50| > a cent; |50.02-50.01| = a cent
  assert.equal(pickCurrentRate({ merchant: 'Best Buy', value: 100 }, rows), null);
});

test('pickCurrentRate: availableCap <= 0 is skipped in favour of another matching row, not fatal', () => {
  const rows = [rateRow({ id: 1, rate: 0.95, availableCap: 0 }), rateRow({ id: 2, rate: 0.8 })];
  assert.equal(pickCurrentRate({ merchant: 'Best Buy', value: 50 }, rows).id, 2);
});

test('pickCurrentRate: highest surviving rate wins; lowest id breaks ties; empty list yields null', () => {
  const rows = [rateRow({ id: 7, rate: 0.8 }), rateRow({ id: 3, rate: 0.9 }), rateRow({ id: 5, rate: 0.9 })];
  assert.equal(pickCurrentRate({ merchant: 'Best Buy', value: 50 }, rows).id, 3);
  assert.equal(pickCurrentRate({ merchant: 'Best Buy', value: 50 }, []), null);
});

// --- planWaitlistRun -------------------------------------------------------

test('planWaitlistRun: a card with no usable rate may EXPIRE but never SUBMITs', () => {
  const rows = [rateRow()]; // Best Buy only -- the Amazon card below has no rate
  const lapsed = [{ id: 'a1', merchant: 'Amazon', value: 50, targetRate: 0.8, maxDate: '2026-01-01' }];
  const live = [{ id: 'a2', merchant: 'Amazon', value: 50, targetRate: 0.8, maxDate: '2030-01-01' }];

  const pLapsed = planWaitlistRun(lapsed, rows, '2026-02-15');
  assert.equal(pLapsed[0].decision, 'EXPIRE');
  assert.equal(pLapsed[0].rate, null);

  const pLive = planWaitlistRun(live, rows, '2026-02-15');
  assert.equal(pLive[0].decision, 'WAIT'); // never SUBMIT with nothing to submit against
  assert.equal(pLive[0].rate, null);
});

test('planWaitlistRun: a card WITH a rate decides on that row\'s rate and reports the deciding row', () => {
  const rows = [rateRow({ id: 9, rate: 0.85 })];
  const c = { id: 'b1', merchant: 'best buy', value: 50, targetRate: 0.86, maxDate: '2030-01-01' };
  const p = planWaitlistRun([c], rows, '2026-02-15');
  assert.equal(p[0].decision, 'WAIT'); // 0.85 < 0.86
  assert.equal(p[0].rate?.id, 9);

  const c2 = { ...c, targetRate: 0.85 };
  assert.equal(planWaitlistRun([c2], rows, '2026-02-15')[0].decision, 'SUBMIT'); // >= boundary via the row's rate
});
