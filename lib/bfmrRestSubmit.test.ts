/**
 * Tests for BFMR REST v2 submit + verify-by-trackings.
 *
 *   node --experimental-strip-types --test lib/bfmrRestSubmit.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { submitTrackerRows, classifyRestVerify, verifyByTrackings } from './bfmrRestSubmit.ts';

/* ── helpers ──────────────────────────────────────────────────────── */

function fakeFetch(responses: Array<{ ok: boolean; status: number; body: any }>) {
  const calls: Array<{ url: string; init: { method?: string; headers?: Record<string, string>; body?: string } }> = [];
  let i = 0;
  const fetchImpl = async (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ) => {
    calls.push({ url, init: { ...init } });
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return {
      ok: r.ok,
      status: r.status,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    };
  };
  return { fetchImpl, calls };
}

const CRED = { apiKey: 'k', apiSecret: 's' };

/* ── submitTrackerRows tests ──────────────────────────────────────── */

test('submitTrackerRows POSTs to the correct URL with method, headers, body', async () => {
  const rows = [{ reserve_id: 'r1', purchase_id: 'p1', tracking_number: 'TBA111' }];
  const { fetchImpl, calls } = fakeFetch([{ ok: true, status: 200, body: { reservations_response: { valid_items: [rows[0]], invalid_items: [] } } }]);
  await submitTrackerRows(fetchImpl, CRED, rows);
  assert.equal(calls.length, 1);
  const c = calls[0];
  assert.equal(c.url, 'https://api.bfmr.com/api/v2/my-tracker');
  assert.equal(c.init.method, 'POST');
  assert.deepEqual(c.init.headers, { 'API-KEY': 'k', 'API-SECRET': 's', 'Content-Type': 'application/json' });
  const parsed = JSON.parse(c.init.body!);
  assert.deepEqual(parsed, { tracker_data: rows });
});

test('submitTrackerRows throws on 0 rows without calling fetch', async () => {
  const { fetchImpl, calls } = fakeFetch([]);
  try {
    await submitTrackerRows(fetchImpl, CRED, []);
    assert.fail('expected throw');
  } catch (e) {
    assert.match((e as Error).message, /1-500 rows required/);
  }
  assert.equal(calls.length, 0);
});

test('submitTrackerRows throws on 501 rows without calling fetch', async () => {
  const { fetchImpl, calls } = fakeFetch([]);
  const rows = Array.from({ length: 501 }, (_, i) => ({ reserve_id: `r${i}`, purchase_id: `p${i}` }));
  try {
    await submitTrackerRows(fetchImpl, CRED, rows);
    assert.fail('expected throw');
  } catch (e) {
    assert.match((e as Error).message, /1-500 rows required/);
  }
  assert.equal(calls.length, 0);
});

test('submitTrackerRows returns valid and invalid items from response', async () => {
  const validRow = { reserve_id: 'r1', purchase_id: 'p1', tracking_number: 'TBA1' };
  const invalidRow = { reserve_id: 'r2', purchase_id: 'p2', tracking_number: '' };
  const rows = [validRow, invalidRow];
  const { fetchImpl } = fakeFetch([{
    ok: true,
    status: 200,
    body: { reservations_response: { valid_items: [validRow], invalid_items: [invalidRow] } },
  }]);
  const result = await submitTrackerRows(fetchImpl, CRED, rows);
  assert.deepEqual(result.valid, [validRow]);
  assert.deepEqual(result.invalid, [invalidRow]);
});

test('submitTrackerRows returns empty arrays when valid_items/invalid_items missing', async () => {
  const rows = [{ reserve_id: 'r1' }];
  const { fetchImpl } = fakeFetch([{
    ok: true,
    status: 200,
    body: {},
  }]);
  const result = await submitTrackerRows(fetchImpl, CRED, rows);
  assert.deepEqual(result.valid, []);
  assert.deepEqual(result.invalid, []);
});

test('submitTrackerRows throws on non-ok 422 response', async () => {
  const rows = [{ reserve_id: 'r1' }];
  const { fetchImpl } = fakeFetch([{
    ok: false,
    status: 422,
    body: { error: 'bad request' },
  }]);
  try {
    await submitTrackerRows(fetchImpl, CRED, rows);
    assert.fail('expected throw');
  } catch (e) {
    assert.match((e as Error).message, /BFMR 422/);
  }
});

/* ── classifyRestVerify tests ─────────────────────────────────────── */

test('classifyRestVerify returns ok when tracking matches expected (case-insensitive, trimmed)', () => {
  const rows = [{ reserve_id: 'r1', purchase_id: 'p1', tracking_number: ' TBA1 ' }];
  assert.equal(classifyRestVerify(rows, { reserveId: 'r1', purchaseId: 'p1' }, 'tba1'), 'ok');
});

test('classifyRestVerify returns not-found when no matching row', () => {
  const rows = [{ reserve_id: 'r2', purchase_id: 'p1', tracking_number: 'TBA1' }];
  assert.equal(classifyRestVerify(rows, { reserveId: 'r1', purchaseId: 'p1' }, 'TBA1'), 'not-found');
});

test('classifyRestVerify returns mismatch when tracking differs', () => {
  const rows = [{ reserve_id: 'r1', purchase_id: 'p1', tracking_number: 'TBA999' }];
  assert.equal(classifyRestVerify(rows, { reserveId: 'r1', purchaseId: 'p1' }, 'TBA1'), 'mismatch');
});

test('classifyRestVerify returns pending when matching row has empty tracking', () => {
  const rows = [{ reserve_id: 'r1', purchase_id: 'p1', tracking_number: '' }];
  assert.equal(classifyRestVerify(rows, { reserveId: 'r1', purchaseId: 'p1' }, 'TBA1'), 'pending');
});

test('a row for another purchase_id does not count as match', () => {
  const rows = [{ reserve_id: 'r1', purchase_id: 'p999', tracking_number: 'TBA1' }];
  assert.equal(classifyRestVerify(rows, { reserveId: 'r1', purchaseId: 'p1' }, 'TBA1'), 'not-found');
});

test('classifyRestVerify handles split shipments: one purchase, several shipment rows', () => {
  const rows = [
    { reserve_id: 'r1', purchase_id: 'p1', tracking_number: 'TBA1' },
    { reserve_id: 'r1', purchase_id: 'p1', tracking_number: 'TBA2' },
  ];
  assert.equal(classifyRestVerify(rows, { reserveId: 'r1', purchaseId: 'p1' }, 'TBA1'), 'ok');
  assert.equal(classifyRestVerify(rows, { reserveId: 'r1', purchaseId: 'p1' }, 'TBA2'), 'ok');
});

/* ── verifyByTrackings tests ──────────────────────────────────────── */

test('verifyByTrackings GETs trackings[] param correctly on first call', async () => {
  const { fetchImpl, calls } = fakeFetch([{
    ok: true,
    status: 200,
    body: { my_tracker: [{ reserve_id: 'r1', purchase_id: 'p1', tracking_number: 'TBA335696557507' }] },
  }]);
  const result = await verifyByTrackings(fetchImpl, CRED, { reserveId: 'r1', purchaseId: 'p1' }, 'TBA335696557507', { sleep: async () => {} });
  assert.equal(calls.length, 1);
  const u = new URL(calls[0].url);
  assert.deepEqual(u.searchParams.getAll('trackings[]'), ['TBA335696557507']);
  assert.equal(u.searchParams.get('quick_filter'), 'all');
  assert.equal(u.searchParams.get('page_size'), '100');
  assert.equal(result.verdict, 'ok');
});

test('verifyByTrackings returns after 1 call on mismatch even with attempts: 3', async () => {
  const { fetchImpl, calls } = fakeFetch([{
    ok: true,
    status: 200,
    body: { my_tracker: [{ reserve_id: 'r1', purchase_id: 'p1', tracking_number: 'TBA999' }] },
  }]);
  const result = await verifyByTrackings(fetchImpl, CRED, { reserveId: 'r1', purchaseId: 'p1' }, 'TBA1', { attempts: 3, delayMs: 0, sleep: async () => {} });
  assert.equal(result.verdict, 'mismatch');
  assert.equal(calls.length, 1);
});

test('verifyByTrackings makes exactly 3 calls for not-found then returns last verdict', async () => {
  const { fetchImpl, calls } = fakeFetch([{
    ok: true,
    status: 200,
    body: { my_tracker: [] },
  }]);
  const result = await verifyByTrackings(fetchImpl, CRED, { reserveId: 'r1', purchaseId: 'p1' }, 'TBA1', { attempts: 3, delayMs: 0, sleep: async () => {} });
  assert.equal(result.verdict, 'not-found');
  assert.equal(calls.length, 3);
  assert.equal(result.actual, null);
});

test('verifyByTrackings: pending then ok across retries', async () => {
  const pendingBody = { my_tracker: [{ reserve_id: 'r1', purchase_id: 'p1', tracking_number: '' }] };
  const okBody = { my_tracker: [{ reserve_id: 'r1', purchase_id: 'p1', tracking_number: 'TBA1' }] };
  const { fetchImpl, calls } = fakeFetch([
    { ok: true, status: 200, body: pendingBody },
    { ok: true, status: 200, body: okBody },
  ]);
  const result = await verifyByTrackings(fetchImpl, CRED, { reserveId: 'r1', purchaseId: 'p1' }, 'TBA1', { attempts: 3, delayMs: 0, sleep: async () => {} });
  assert.equal(result.verdict, 'ok');
  assert.equal(calls.length, 2);
  assert.equal(result.actual, 'TBA1');
});

test('verifyByTrackings actual is trimmed tracking_number of first matching row, or null', async () => {
  const { fetchImpl } = fakeFetch([{
    ok: true,
    status: 200,
    body: { my_tracker: [{ reserve_id: 'r1', purchase_id: 'p1', tracking_number: ' TBA1 ' }] },
  }]);
  const result = await verifyByTrackings(fetchImpl, CRED, { reserveId: 'r1', purchaseId: 'p1' }, 'tba1', { sleep: async () => {} });
  assert.equal(result.actual, 'TBA1');
});

test('verifyByTrackings defaults: attempts=3, delayMs=500', async () => {
  const { fetchImpl, calls } = fakeFetch([{
    ok: true,
    status: 200,
    body: { my_tracker: [] },
  }]);
  // Without opts, should default to attempts=3
  const result = await verifyByTrackings(fetchImpl, CRED, { reserveId: 'r1', purchaseId: 'p1' }, 'TBA1', { sleep: async () => {} });
  assert.equal(calls.length, 3);
  assert.equal(result.verdict, 'not-found');
});
