import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pushFailures, failuresByUser, linkFailures, type FillStore } from './fillFailureCore.ts';
import type { FillFailure } from './fillFailureAlert.ts';

const ADDR = '100 Test St, Springfield, ZZ, 00001, USA';
const link = (n: string): FillFailure => ({ kind: 'link', orderNumber: n, reason: 'several' });

function fake(opts: { creds?: boolean; failSend?: boolean; told?: string[] } = {}) {
  const sent: string[] = [];
  let told = opts.told ?? [];
  const store: FillStore = {
    getTold: async () => { await new Promise(r => setTimeout(r, 5)); return told; },
    saveTold: async (_u, k) => { told = k; },
    getPushover: async () => (opts.creds === false ? null : { key: 'k', token: 't' }),
    send: async (_c, text) => { await new Promise(r => setTimeout(r, 5)); if (opts.failSend) throw new Error('down'); sent.push(text); },
  };
  return { store, sent, told: () => told };
}

test('pushFailures: sends once, remembers after the send, never repeats', async () => {
  const f = fake();
  assert.equal(await pushFailures(f.store, 1, [link('100')]), 1);
  assert.equal(await pushFailures(f.store, 1, [link('100')]), 0);
  assert.equal(f.sent.length, 1);
  assert.equal(f.told().length, 1);
});

test('pushFailures: a failed send is not remembered, so it is told next run', async () => {
  const bad = fake({ failSend: true });
  assert.equal(await pushFailures(bad.store, 1, [link('100')]), 0);
  assert.deepEqual(bad.told(), []);
});

test('pushFailures: without Pushover the issue is remembered but nothing is counted as sent', async () => {
  const f = fake({ creds: false });
  assert.equal(await pushFailures(f.store, 1, [link('100')]), 0);
  assert.equal(f.told().length, 1);
});

test('pushFailures: overlapping runs for one user tell an issue once', async () => {
  const f = fake();
  await Promise.all([pushFailures(f.store, 1, [link('100')]), pushFailures(f.store, 1, [link('100')])]);
  assert.equal(f.sent.length, 1);
});

test('failuresByUser: scoped to the command owner and their own orders', () => {
  const base = { platform: 'Walmart', itemDescription: '', shippingAddress: ADDR, trackingNumbers: null, cardId: 3 };
  const out = failuresByUser(
    [{ status: 'done', orderNumbers: ['1000000000001', '1000000000002'], userId: 1 }, { status: 'done', orderNumbers: ['1000000000003'], userId: null }],
    [{ ...base, orderNumber: '1000000000001', userId: 1 }, { ...base, orderNumber: '1000000000002', userId: 2 }, { ...base, orderNumber: '1000000000003', userId: 1 }],
  );
  assert.deepEqual([...out.keys()], [1]);
  assert.deepEqual(out.get(1)?.map(x => x.orderNumber), ['1000000000001']);
});

test('linkFailures: only decisions the person must make are pushed, never "none"', () => {
  const nums = new Map([[1, '100'], [2, '200'], [3, '300'], [4, null]]);
  const out = linkFailures([
    { orderId: 1, reason: 'none' }, { orderId: 2, reason: 'several' }, { orderId: 3, reason: 'too-many' }, { orderId: 4, reason: 'several' }, { orderId: 9, reason: 'qty-unknown' },
  ], nums);
  assert.deepEqual(out.map(x => x.kind === 'link' && x.reason), ['several', 'too-many']);
});
