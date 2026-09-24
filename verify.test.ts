// Adversarial repo-style test for: rt-dashboard-pl-unsubmitted-cc   (node --test / tsx --test)
//
// Integration fixture: mocks the page's external modules (@/lib/db, @/lib/auth,
// next/link), imports the REAL DashboardPage from app/page.tsx, drives it as a
// component call, and asserts on the exact prisma.order.findMany where-clauses
// it issues. The pin under test: the three P&L period queries (current_month,
// current_quarter, ytd) must carry the SAME unsubmittedCCFilter that
// app/api/analytics/route.ts applies — excluding Card Center orders whose gift
// cards are ALL unsubmitted — while a partially-submitted CC order and plain
// non-CC orders stay in scope.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

// DashboardPage returns a React element tree; flatten it to markup so we can
// assert on the rendered values.
function html(el: any): string {
  return typeof el === 'string' ? el : renderToStaticMarkup(el);
}

const UNSUBMITTED_CC_FILTER = { NOT: { AND: [{ giftCards: { some: {} } }, { giftCards: { every: { ccSubmittedAt: null } } }] } };

// Fake prisma client: records every findMany call; returns whatever the test
// sets on `rows`.
const calls: any[] = [];
let rows: any[] = [];
mock.module('@/lib/db', { namedExports: { prisma: { order: { findMany: async (args: any) => { calls.push(args); return rows; } } } } });

// Auth: a logged-in user by default, so the where-clauses carry userId and we
// can assert the filter is applied ALONGSIDE the existing user/cancelled/
// ignoredByRule conditions rather than replacing them. `authImpl` is mutable so
// a test can flip it to throw without re-mocking an already-mocked module.
let authImpl: () => Promise<number | null> = async () => 7;
mock.module('@/lib/auth', { namedExports: { getSessionUserId: () => authImpl() } });

// next/link renders as a plain <a> so the page's JSX executes under tsx.
mock.module('next/link', { defaultExport: (props: any) => props.children ?? null, namedExports: {} });

// Lazy load AFTER the mock.module registrations above so app/page.tsx binds to
// the fakes on first import (tsx compiles this file as CJS — no top-level await).
async function getPage() {
  const mod: any = await import('./app/page');
  return mod.default;
}

beforeEach(() => { calls.length = 0; rows = []; });

test('month/quarter/YTD P&L queries all carry the unsubmittedCCFilter alongside cancelled:false + ignoredByRule:false', async () => {
  const DashboardPage = await getPage();
  await DashboardPage();
  assert.equal(calls.length, 4, 'expected exactly 4 findMany calls (all-time + 3 periods)');

  const periodCalls = [calls[1], calls[2], calls[3]];
  for (const c of periodCalls) {
    // The exact clause from app/api/analytics/route.ts — deep-equal, so a
    // reworded/negated/loosened filter fails here.
    assert.deepEqual(c.where.NOT, UNSUBMITTED_CC_FILTER.NOT, 'period query must embed the analytics unsubmittedCCFilter');
    // Existing filters preserved on the same where-clause.
    assert.equal(c.where.cancelled, false);
    assert.equal(c.where.ignoredByRule, false);
    assert.equal(c.where.userId, 7);
    assert.ok(c.where.orderDate && c.where.orderDate.gte instanceof Date && c.where.orderDate.lte instanceof Date, 'period query must keep its orderDate range');
  }

  // The three periods are distinct ranges (month < quarter < ytd), not one
  // copy-pasted range.
  const starts = periodCalls.map(c => c.where.orderDate.gte.getTime());
  assert.equal(new Set(starts).size, 3, 'the three period queries must use three different date ranges');
});

test('over-trigger guard: the all-time query is untouched (no unsubmittedCCFilter, no cancelled:false) and still renders orders', async () => {
  rows = [{
    id: 1, salePrice: 100, cost: 40, shippingCost: 5, insuranceCost: 0, returnedCost: 0,
    cashbackAmount: 2, portalCashback: null, amexOfferDollars: 0, amexOfferPoints: 0,
    orderDate: new Date(), platform: 'amazon', cancelled: false, lost: false, salePriceSynced: true,
    blockedAddressPattern: null, itemDescription: 'Widget', buyer: { name: 'Buyer One' },
    card: { milesProgram: null, basePointsPerDollar: 0, merchantRates: [] },
    returns: [], bfmrLinks: [], commitmentLinks: [], overdueAt: null, bgPaidAmount: null,
    bgCredited: false, bfmrStatus: null, bgExpectedPayout: null, bfmrRejectedItems: null,
  }];
  const DashboardPage = await getPage();
  const out = html(await DashboardPage());

  // calls[0] is the all-time list query — it must NOT gain the CC filter or a
  // cancelled:false (that would change "All Time" semantics this task never asked for).
  assert.equal(calls[0].where.NOT, undefined, 'all-time query must not carry unsubmittedCCFilter');
  assert.ok(!('cancelled' in calls[0].where), 'all-time query must keep its existing where-shape (no cancelled flag)');
  assert.deepEqual(calls[0].where, { userId: 7 });

  // The page still renders the order data end-to-end.
  const s = out;
  assert.ok(s.includes('Buyer One'), 'recent orders table must render the buyer name');
  assert.ok(s.includes('$100.00'), 'sale price must render in the recent orders row');
});

test('a partially-submitted CC order still counts: rows returned by a period query flow into the P&L totals', async () => {
  const DashboardPage = await getPage();
  // One order with one submitted + one unsubmitted gift card (partial) — the
  // filter keeps it, so whatever the DB returns for the month range must reach
  // the "This Month" profit card.
  rows = [{
    id: 2, salePrice: 50, cost: 10, shippingCost: 0, insuranceCost: 0, returnedCost: 0,
    cashbackAmount: 0, portalCashback: null, amexOfferDollars: 0, amexOfferPoints: 0,
    orderDate: new Date(), platform: 'amazon', cancelled: false, lost: false, salePriceSynced: true,
    blockedAddressPattern: null, itemDescription: 'Partial CC order', buyer: { name: 'CC Buyer' },
    card: { milesProgram: null, basePointsPerDollar: 0, merchantRates: [] },
    returns: [], bfmrLinks: [], commitmentLinks: [], overdueAt: null, bgPaidAmount: null,
    bgCredited: false, bfmrStatus: null, bgExpectedPayout: null, bfmrRejectedItems: null,
  }];
  const out = html(await DashboardPage());
  // profit = 50 - (10 + 0 + 0 - 0) + 0 = $40.00 must appear in a period card.
  assert.ok(out.includes('$40.00'), 'partially-submitted CC order P&L must reach the month/quarter/YTD profit cards');
});

test('auth failure propagates as a rejection (no swallowed error, no fake success)', async () => {
  const DashboardPage = await getPage();
  authImpl = async () => { throw new Error('session exploded'); };
  try {
    await assert.rejects(DashboardPage(), /session exploded/);
  } finally {
    authImpl = async () => 7;
  }
});
