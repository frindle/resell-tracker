// Adversarial repo-style test for: rt-bfmr-mytrackerid-preserve   (node --test / tsx --test)
//
// Integration fixture: imports the REAL exported POST handler from
// app/api/bfmr/sync-reservations/route.ts, drives it with a Request, and
// asserts res.status + parsed JSON body. All external modules (db, auth,
// BFMR clients, backfill libs) are stubbed via mock.module so the ONLY real
// code under test is the route itself -- including which keys its Prisma
// upsert's update object contains.
//
// The core guard: when a REST tracker item OMITS my_tracker_id, the UPDATE
// branch must OMIT `myTrackerId` from the update payload entirely (so a value
// previously written by the Web-App backfill survives), while the CREATE
// branch still sets it to null. A plausible-but-wrong impl that keeps
// `myTrackerId: ... : null` in the update object fails case 3; an over-eager
// fix that also drops the key from create fails the same case's create assert;
// a fix that stops setting Number(my_tracker_id) when present fails case 4.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

type UpsertCall = { where: unknown; create: Record<string, unknown>; update: Record<string, unknown> };

// Mutable inputs the mocks close over -- each test re-points them before calling POST.
let sessionUid: string | null = 'user-1';
const settingsMap: Record<string, string> = { bfmr_api_key: 'k', bfmr_api_secret: 's' };
let trackerItems: Array<Record<string, unknown>> = [];
const upsertCalls: UpsertCall[] = [];

const prisma = {
  bfmrReservation: {
    upsert: async (args: UpsertCall) => { upsertCalls.push(args); return { id: 1 }; },
    findMany: async () => [], // no rows need Web backfill -> scrape path never runs
    count: async () => 0,
    update: async () => ({ id: 1 }),
  },
  $transaction: async (ops: unknown[]) => ops,
};
const getSetting = async (_uid: string, key: string) =>
  key in settingsMap ? { value: settingsMap[key] } : null;

mock.module('@/lib/auth', { namedExports: { getSessionUserId: async () => sessionUid } });
mock.module('@/lib/extensionAuth', {
  namedExports: { resolveExtensionUserId: (_req: Request, uid: string | null) => uid ?? null },
});
mock.module('@/lib/db', { namedExports: { prisma, getSetting } });
mock.module('@/lib/bfmr', {
  namedExports: {
    getMyTracker: async () => [],
    getMyTrackerAll: async () => trackerItems,
    deriveBfmrStatus: (item: Record<string, unknown>) => String(item.status ?? 'purchased'),
  },
});
mock.module('@/lib/bfmrWeb', {
  namedExports: {
    getWebTrackerRows: async () => { throw new Error('web scrape must not run in these fixtures'); },
    WEB_BACKFILL_FETCH: 50,
  },
});
mock.module('@/lib/bfmrJoin', {
  namedExports: {
    normalizeBackfillLocal: (x: unknown) => x,
    resolveTrackerBackfill: () => ({ matchedUpdates: [], stampIds: [], counts: { backfilled: 0, ambiguous: 0, unmatched: 0 }, samples: { web: [], local: [] } }),
  },
});
mock.module('@/lib/bfmrAutoLink', { namedExports: { autoLinkBfmrReservations: async () => 0 } });
mock.module('@/lib/bfmrSalePrice', { namedExports: { findStaleBfmrLinkValues: async () => [] } });
mock.module('@/lib/bfmrReservationLineKey', {
  namedExports: {
    reservationLineKey: (item: Record<string, unknown>) => String(item.reserve_id ?? item.purchase_id ?? item.shipment_id),
  },
});

// Import AFTER the mocks are registered (above) so the route's imports resolve
// to them. Dynamic import inside a helper keeps this file CJS-compatible under
// tsx; the first call loads the real module, later calls hit the cache.
async function post() {
  const { POST } = await import('./app/api/bfmr/sync-reservations/route');
  return POST(new Request('http://localhost/api/bfmr/sync-reservations', { method: 'POST' }));
}

test('unauthenticated caller gets 401 (not a 500)', async () => {
  sessionUid = null;
  try {
    const res = await post();
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'not authenticated' });
  } finally {
    sessionUid = 'user-1';
  }
});

test('missing BFMR credentials get 400 with the configured-error shape', async () => {
  delete settingsMap.bfmr_api_key;
  try {
    const res = await post();
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'BFMR API credentials not configured' });
  } finally {
    settingsMap.bfmr_api_key = 'k';
  }
});

test('UPDATE branch OMITS myTrackerId when REST item lacks it; CREATE still nulls it', async () => {
  upsertCalls.length = 0;
  trackerItems = [{ reserve_id: 'R1', qty: 2, status: 'purchased' }]; // no my_tracker_id -- the routine REST case
  const res = await post();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.synced, 1);
  assert.equal(body.fetched, 1);
  assert.equal(body.unique, 1);

  assert.equal(upsertCalls.length, 1);
  const call = upsertCalls[0];
  // THE FIX: update payload must not carry the key at all -- Prisma leaves
  // the previously-backfilled value untouched. A `myTrackerId: null` here is
  // exactly the bug this task fixes.
  assert.ok(!('myTrackerId' in call.update), 'update object must OMIT myTrackerId when REST omits it (got: %j)', JSON.stringify(call.update));
  // OVER-TRIGGER GUARD: the CREATE branch is unaffected and still sets null
  // for a brand-new row (no prior value to preserve).
  assert.ok('myTrackerId' in call.create, 'create object must still carry myTrackerId');
  assert.equal(call.create.myTrackerId, null);
});

test('UPDATE branch overwrites with Number(my_tracker_id) when REST provides it', async () => {
  upsertCalls.length = 0;
  trackerItems = [{ reserve_id: 'R1', qty: 2, status: 'purchased', my_tracker_id: '4869593' }];
  const res = await post();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.synced, 1);

  assert.equal(upsertCalls.length, 1);
  const call = upsertCalls[0];
  // A real REST-provided value still wins and overwrites -- as a Number.
  assert.ok('myTrackerId' in call.update, 'update object must set myTrackerId when REST provides it');
  assert.equal(call.update.myTrackerId, 4869593);
  assert.equal(typeof call.update.myTrackerId, 'number');
  // CREATE branch mirrors the same value.
  assert.equal(call.create.myTrackerId, 4869593);
});

test('sync response keeps its diagnostic shape (integration body check)', async () => {
  upsertCalls.length = 0;
  trackerItems = [
    { reserve_id: 'R1', qty: 2, status: 'purchased' },
    { purchase_id: 'P9', qty: 1, status: 'shipped', my_tracker_id: '7' },
  ];
  const res = await post();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.synced, 2);
  assert.equal(body.fetched, 2);
  assert.equal(body.unique, 2);
  assert.equal(body.reserveIdCollisions, 0);
  assert.equal(body.webBackfilled, 0);
  assert.equal(body.autoLinked, 0);

  const lineKeys = upsertCalls.map(c => (c.where as { userId_lineKey: { lineKey: string } }).userId_lineKey.lineKey).sort();
  assert.deepEqual(lineKeys, ['P9', 'R1']);
  // The item WITHOUT my_tracker_id omits the key on update; the one WITH it sets Number(7).
  const r1 = upsertCalls.find(c => (c.where as { userId_lineKey: { lineKey: string } }).userId_lineKey.lineKey === 'R1')!;
  assert.ok(!('myTrackerId' in r1.update));
  const p9 = upsertCalls.find(c => (c.where as { userId_lineKey: { lineKey: string } }).userId_lineKey.lineKey === 'P9')!;
  assert.equal(p9.update.myTrackerId, 7);
});
