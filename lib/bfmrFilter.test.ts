// Test file for trackings[] / orders[] array filters in getMyTracker
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getMyTracker } from './bfmr.ts';

const BASE = 'https://api.bfmr.com/api/v2';

function makeResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Helper: call getMyTracker with a mocked fetch, record the URL,
 * and return the parsed searchParams so we can inspect them.
 */
async function captureUrl(creds: Parameters<typeof getMyTracker>[0], filters: Parameters<typeof getMyTracker>[1]) {
  const saved = globalThis.fetch;
  let recordedUrl = '';

  try {
    (globalThis as any).fetch = async (url: string | URL | Request, _init?: RequestInit) => {
      recordedUrl = url.toString();
      return makeResponse({ my_tracker: [] });
    };

    await getMyTracker(creds, filters);

    const u = new URL(recordedUrl);
    return {
      pathname: u.pathname,
      params: u.searchParams,
    };
  } finally {
    (globalThis as any).fetch = saved;
  }
}

test('trackings[]: repeated bracketed keys for each tracking number', async () => {
  const creds = { apiKey: 'k', apiSecret: 's' };
  const result = await captureUrl(creds, { trackings: ['TBA1', 'TBA2'] });

  // Must NOT have a plain "trackings" key
  assert.equal(result.params.has('trackings'), false, 'plain "trackings" key must not exist');

  // Must have repeated "trackings[]" keys
  const trackingsArr = result.params.getAll('trackings[]');
  assert.deepEqual(trackingsArr, ['TBA1', 'TBA2'], 'trackings[] values must match input order');

  // Path check
  assert.equal(result.pathname, '/api/v2/my-tracker', 'path must be /api/v2/my-tracker');
});

test('orders[]: repeated bracketed keys for each order number', async () => {
  const creds = { apiKey: 'k', apiSecret: 's' };
  const result = await captureUrl(creds, { orders: ['111-2213508-9161019'] });

  // Must NOT have a plain "orders" key
  assert.equal(result.params.has('orders'), false, 'plain "orders" key must not exist');

  // Must have repeated "orders[]" keys
  const ordersArr = result.params.getAll('orders[]');
  assert.deepEqual(ordersArr, ['111-2213508-9161019'], 'orders[] values must match input');
});

test('trackings[] + other filters: trims empty strings, keeps non-array filters', async () => {
  const creds = { apiKey: 'k', apiSecret: 's' };
  const result = await captureUrl(creds, { trackings: [' TBA1 ', ''], page_size: 200, quick_filter: 'all' });

  // Empty string after trim should be skipped; only 'TBA1' remains
  const trackingsArr = result.params.getAll('trackings[]');
  assert.deepEqual(trackingsArr, ['TBA1'], 'only non-empty trimmed values should appear');

  // Other filter keys must still be present as-is
  assert.equal(result.params.get('page_size'), '200', 'page_size must pass through');
  assert.equal(result.params.get('quick_filter'), 'all', 'quick_filter must pass through');
});

test('missing trackings/orders arrays produce no bracketed keys', async () => {
  const creds = { apiKey: 'k', apiSecret: 's' };
  const result = await captureUrl(creds, { page_size: 100 });

  assert.equal(result.params.has('trackings'), false, 'no trackings when not provided');
  assert.equal(result.params.has('trackings[]'), false, 'no trackings[] when not provided');
  assert.equal(result.params.has('orders'), false, 'no orders when not provided');
  assert.equal(result.params.has('orders[]'), false, 'no orders[] when not provided');
  assert.equal(result.params.get('page_size'), '100', 'other filters still work');
});
