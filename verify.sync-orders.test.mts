// Adversarial behavioural verify for: bfmr-sync-orders-paginate
//
// PROPERTY under test: the sync-orders `fetch:true` server-side block must page
// through ALL BFMR tracker pages (getMyTrackerAll) and ingest every row, not
// just page 1 (getMyTracker, page_size 200).
//
// HOW it drives the real route without mocking it:
//   - We call the REAL exported POST handler from
//     app/api/bfmr/sync-orders/route.ts (not a reimplementation).
//   - We stub the transport boundary ONLY: globalThis.fetch, which lib/bfmr's
//     module-level bfmrFetch() calls. getMyTracker / getMyTrackerAll run for
//     real on top of the stub, so the assertion measures which one the route
//     invokes -- exactly the change site. (Testing getMyTrackerAll in isolation
//     would NOT discriminate: it already paginates today and passes.)
//   - next/headers is redirected to a no-request-scope stub via verify.tsconfig
//     (cookies() throws outside a Next request); that is framework harness
//     scaffolding, not the route logic. The acting user comes from the
//     X-Extension-User-Id header instead.
//   - A dedicated temp SQLite DB (DATABASE_URL, set by verify.sh) so getSetting
//     returns creds and the route runs end to end.
//
// The route returns `total: items.length` (rows it fetched). Each case makes the
// stub serve N full pages then a short page, and asserts BOTH:
//   * trackerCalls === expected page count (page_no 1..N until a short page), and
//   * response.total === the full row count across all pages.
// On the current single-page getMyTracker call these are ALWAYS calls===1 and
// total===200, so every case below FAILS at baseline and PASSES after the swap.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Refuse to run against anything but a dedicated throwaway DB -- never dev.db.
const DB = process.env.DATABASE_URL ?? '';
if (!DB || !/verify-sync-orders/.test(DB)) {
  throw new Error(`refusing to run without a dedicated test DATABASE_URL (got: ${DB || 'unset'})`);
}

const PAGE_SIZE = 200;

// Install a fresh transport stub that serves `fullPages` pages of PAGE_SIZE rows
// followed by one page of `shortLast` rows (shortLast < PAGE_SIZE stops
// getMyTrackerAll). Returns a live counter object.
function installStub(fullPages: number, shortLast: number) {
  const state = { calls: 0, pages: [] as number[] };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: unknown) => {
    const u = String(url);
    if (u.includes('/my-tracker')) {
      state.calls++;
      const pno = Number(new URL(u).searchParams.get('page_no') ?? '1');
      state.pages.push(pno);
      const size = pno <= fullPages ? PAGE_SIZE : (pno === fullPages + 1 ? shortLast : 0);
      // Minimal rows: no order_id / tracking_number, so they are neither created
      // nor matched -- they only count toward `total`, isolating the fetch count.
      const items = Array.from({ length: size }, () => ({ status: 'shipped' }));
      return new Response(JSON.stringify({ my_tracker: items }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    return (realFetch as typeof fetch)(url as never, init as never);
  }) as typeof fetch;
  return state;
}

async function seedCreds() {
  const { prisma } = await import('@/lib/db');
  await prisma.setting.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.user.create({ data: { id: 7, name: 'verify' } });
  await prisma.setting.create({ data: { userId: 7, key: 'bfmr_api_key', value: 'K' } });
  await prisma.setting.create({ data: { userId: 7, key: 'bfmr_api_secret', value: 'S' } });
}

async function driveSync(): Promise<{ total: number }> {
  const { POST } = await import('@/app/api/bfmr/sync-orders/route');
  const req = new Request('http://localhost/api/bfmr/sync-orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Extension-User-Id': '7' },
    body: JSON.stringify({ items: [], fetch: true }),
  });
  const res = await (POST as (r: Request) => Promise<Response>)(req);
  return (await res.json()) as { total: number };
}

beforeEach(seedCreds);

// Case 1: 3 full pages (200 each) + a short page of 50 => 650 rows across 4 requests.
// Baseline (page 1 only): calls===1, total===200 -> FAILS both assertions.
test('pages through every tracker page (200,200,200,50) and ingests all 650 rows', async () => {
  const stub = installStub(3, 50);
  const { total } = await driveSync();
  assert.equal(stub.calls, 4, `expected 4 tracker requests (page_no 1..4), got ${stub.calls}`);
  assert.deepEqual(stub.pages, [1, 2, 3, 4], `expected sequential page_no 1..4, got ${JSON.stringify(stub.pages)}`);
  assert.equal(total, 650, `expected all 650 rows ingested, got ${total}`);
  assert.ok(total > PAGE_SIZE, `must ingest more than one page (${PAGE_SIZE}), got ${total}`);
});

// Case 2: stops on the FIRST short page (200,50) => 250 rows across 2 requests.
// Proves it neither stops at page 1 (baseline: 1 call / 200) nor over-fetches.
test('stops at the first short page (200,50): 2 requests, 250 rows', async () => {
  const stub = installStub(1, 50);
  const { total } = await driveSync();
  assert.equal(stub.calls, 2, `expected 2 tracker requests, got ${stub.calls}`);
  assert.equal(total, 250, `expected 250 rows ingested, got ${total}`);
  assert.ok(stub.calls > 1, `must request more than one page, got ${stub.calls}`);
});

// Case 3: many full pages (5x200) + short (30) => 1030 rows across 6 requests.
// Proves pagination is unbounded-until-short, not a fixed small page count, and
// that the full row count (not 200) reaches the route regardless of scale.
test('paginates an arbitrary number of pages (5x200 + 30): 6 requests, 1030 rows', async () => {
  const stub = installStub(5, 30);
  const { total } = await driveSync();
  assert.equal(stub.calls, 6, `expected 6 tracker requests, got ${stub.calls}`);
  assert.deepEqual(stub.pages, [1, 2, 3, 4, 5, 6], `expected sequential page_no 1..6, got ${JSON.stringify(stub.pages)}`);
  assert.equal(total, 1030, `expected 1030 rows ingested, got ${total}`);
});
