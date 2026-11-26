import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRead, isFresh, moneyToShow, summarizeReads, READ_TTL_MS, READ_FAIL_TTL_MS, type ReadEntry } from './bloomRead.ts';

const money = (gross: number, month = '2026-11') => ({ month, grossCents: gross, otherIncomeCents: 0, feesCents: 0, costsCents: 0, netCents: gross, toDate: true });
const T0 = Date.parse('2026-11-10T12:00:00Z');

test('a failed first read is unavailable, never zero', () => {
  const e = applyRead(undefined, { ok: false }, T0);
  assert.equal(moneyToShow(e), null);
  assert.deepEqual(summarizeReads([e]), { state: 'unavailable', asOf: null });
});

test('a failed read keeps the last good value and marks it as of its read time', () => {
  const good = applyRead(undefined, { ok: true, value: money(12_345) }, T0);
  const failed = applyRead(good, { ok: false }, T0 + 10 * 60_000);
  assert.equal(moneyToShow(failed)?.grossCents, 12_345);
  assert.deepEqual(summarizeReads([failed]), { state: 'stale', asOf: new Date(T0).toISOString() });
});

test('a later good read replaces the stale value and clears the mark', () => {
  const failed = applyRead(applyRead(undefined, { ok: true, value: money(100) }, T0), { ok: false }, T0 + 1);
  const back = applyRead(failed, { ok: true, value: money(250) }, T0 + 2);
  assert.equal(moneyToShow(back)?.grossCents, 250);
  assert.deepEqual(summarizeReads([back]), { state: 'ok', asOf: null });
});

test('a successful empty read on a fresh month is "no earnings"', () => {
  const e = applyRead(undefined, { ok: true, value: money(0) }, T0);
  assert.equal(moneyToShow(e), null);
  assert.deepEqual(summarizeReads([e]), { state: 'none', asOf: null });
});

test('an all-zero answer after real earnings is held back as stale', () => {
  const good = applyRead(undefined, { ok: true, value: money(5_000) }, T0);
  const zero = applyRead(good, { ok: true, value: money(0) }, T0 + 1000);
  assert.equal(moneyToShow(zero)?.grossCents, 5_000);
  assert.equal(summarizeReads([zero]).state, 'stale');
});

test('cache freshness: failures are retried sooner than successes', () => {
  const ok = applyRead(undefined, { ok: true, value: money(1) }, T0);
  const bad = applyRead(undefined, { ok: false }, T0);
  assert.equal(isFresh(ok, T0 + READ_FAIL_TTL_MS + 1), true);
  assert.equal(isFresh(bad, T0 + READ_FAIL_TTL_MS + 1), false);
  assert.equal(isFresh(ok, T0 + READ_TTL_MS + 1), false);
  assert.equal(isFresh(undefined, T0), false);
});

test('summary: nothing to read is ok; a missing entry is unavailable; worst state wins', () => {
  assert.deepEqual(summarizeReads([]), { state: 'ok', asOf: null });
  assert.equal(summarizeReads([undefined]).state, 'unavailable');
  const good = applyRead(undefined, { ok: true, value: money(1) }, T0);
  const stale: ReadEntry = applyRead(good, { ok: false }, T0 + 1);
  const none = applyRead(undefined, { ok: true, value: money(0, '2026-10') }, T0);
  assert.equal(summarizeReads([none, stale]).state, 'stale');
  assert.equal(summarizeReads([none, good]).state, 'ok');
});
