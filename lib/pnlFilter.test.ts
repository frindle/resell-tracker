import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { countsTowardPnl, PNL_ORDER_WHERE } from './pnlFilter.ts';

const base = { cancelled: false, ignoredByRule: false, giftCards: [] as { ccSubmittedAt: string | null }[] };

test('plain order with no gift cards counts', () => {
  assert.equal(countsTowardPnl(base), true);
});
test('Card Center order with every card unsubmitted is left out', () => {
  assert.equal(countsTowardPnl({ ...base, giftCards: [{ ccSubmittedAt: null }, { ccSubmittedAt: null }] }), false);
});
test('partly submitted order counts', () => {
  assert.equal(countsTowardPnl({ ...base, giftCards: [{ ccSubmittedAt: null }, { ccSubmittedAt: '2026-11-01' }] }), true);
});
test('fully submitted order counts', () => {
  assert.equal(countsTowardPnl({ ...base, giftCards: [{ ccSubmittedAt: '2026-11-01' }] }), true);
});
test('cancelled or rule-ignored orders are left out', () => {
  assert.equal(countsTowardPnl({ ...base, cancelled: true }), false);
  assert.equal(countsTowardPnl({ ...base, ignoredByRule: true }), false);
});
test('Prisma filter has the same three rules', () => {
  assert.equal(PNL_ORDER_WHERE.cancelled, false);
  assert.equal(PNL_ORDER_WHERE.ignoredByRule, false);
  assert.deepEqual(PNL_ORDER_WHERE.NOT, { AND: [{ giftCards: { some: {} } }, { giftCards: { every: { ccSubmittedAt: null } } }] });
});
// Guard against the two pages drifting apart again: every P&L query on both
// surfaces must use the shared filter.
test('dashboard profit cards and analytics both use PNL_ORDER_WHERE', () => {
  const page = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
  const route = readFileSync(new URL('../app/api/analytics/route.ts', import.meta.url), 'utf8');
  assert.equal((page.match(/\.\.\.PNL_ORDER_WHERE/g) ?? []).length, 4, 'all time, month, quarter, YTD');
  assert.match(page, /calcStats\(allPnlOrders\)/);
  assert.doesNotMatch(page, /calcStats\(allOrders\)/);
  assert.equal((route.match(/\.\.\.PNL_ORDER_WHERE/g) ?? []).length, 3, 'period, prior year, monthly chart');
});
