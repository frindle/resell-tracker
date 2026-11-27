import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backfillEgiftFromArchive } from './egiftBackfill.ts';
import { sweepLinkedOrders, type SweepDeps, type CandidateOrder } from './egiftIngest.ts';

// Synthetic only: fake addresses, order numbers and links.
const cf = { url: 'https://inbox.example.test', token: 'synthetic' };
const LINK = 'https://www.memberedelivery.com/?login=SYNTHETICTOKEN';
const mime = (html: string) => [
  'From: Costco <eGift@costco.com>', 'To: buyer@example.com', 'Subject: Your Costco eGift is ready',
  'Message-ID: <synthetic@example.com>', 'Date: Mon, 16 Nov 2026 10:00:00 -0800', 'MIME-Version: 1.0',
  'Content-Type: text/html; charset=utf-8', '', html,
].join('\r\n');
const DELIVERY = mime(`<p>Order Number: 000000001</p><a href="${LINK}">Access eGift</a>`);
const ORDINARY = mime('<p>Thank you for your order</p><p>Order Number: 000000002</p>');

function archiveFetch(raws: Record<string, string>, opts: { listFails?: boolean } = {}) {
  const urls: string[] = [];
  const f = (async (url: string) => {
    urls.push(url);
    const u = new URL(url);
    if (u.pathname === '/archive') {
      if (opts.listFails) return new Response('boom', { status: 500 });
      const messages = Object.keys(raws).map(id => ({ id, to: 'inbox@example.test', from: 'eGift@costco.com', size: 1, receivedAt: '2026-11-16T10:00:00Z' }));
      return Response.json({ messages, cursor: null, complete: true });
    }
    const id = decodeURIComponent(u.pathname.replace('/archive/', ''));
    return id in raws ? new Response(raws[id]) : new Response('', { status: 404 });
  }) as unknown as typeof fetch;
  return { f, urls };
}

test('archive delivery emails are ingested; ordinary mail is not', async () => {
  const { f, urls } = archiveFetch({ a: DELIVERY, b: ORDINARY, c: DELIVERY });
  const seen: string[][] = [];
  const r = await backfillEgiftFromArchive(cf, async emails => { seen.push(emails.map(e => e.egiftDelivery!.orderNumber)); }, f);
  assert.deepEqual([r.ok, r.listed, r.parsed, r.deliveries], [true, 3, 3, 2]);
  assert.deepEqual(seen, [['000000001', '000000001']]);
  assert.ok(urls.every(u => !u.includes('/messages')), 'only the archive is read');
});

test('a failed archive listing is not ok, so it is retried', async () => {
  const { f } = archiveFetch({ a: DELIVERY }, { listFails: true });
  let called = false;
  const r = await backfillEgiftFromArchive(cf, async () => { called = true; }, f);
  assert.equal(r.ok, false);
  assert.equal(called, false);
});

test('an unreadable message is skipped and the rest still ingest', async () => {
  const { f } = archiveFetch({ a: DELIVERY });
  const gone = ((u: string, i?: RequestInit) => (u.includes('/archive/a') ? Promise.resolve(new Response('', { status: 404 })) : f(u, i))) as typeof fetch;
  let n = 0;
  const r = await backfillEgiftFromArchive(cf, async e => { n = e.length; }, gone);
  assert.deepEqual([r.ok, r.deliveries, n], [true, 0, 0]);
});

function sweepFake(orders: CandidateOrder[], init: { cards?: number[]; commands?: number[]; email?: boolean } = {}) {
  const queued: number[] = [];
  const deps: SweepDeps = {
    listLinkedOrders: async () => orders,
    hasCards: async id => (init.cards ?? []).includes(id),
    hasScrapeCommand: async id => (init.commands ?? []).includes(id) || queued.includes(id),
    hasAnyEmail: async () => !!init.email,
    queueScrape: async id => { queued.push(id); },
  };
  return { deps, queued };
}
const O = (id: number): CandidateOrder => ({ id, userId: 1, orderNumber: `00000000${id}` });

test('sweep: no address means waiting, nothing queued', async () => {
  const { deps, queued } = sweepFake([O(1), O(2)]);
  assert.deepEqual(await sweepLinkedOrders(deps), { queued: 0, waiting: 2, failed: 0 });
  assert.deepEqual(queued, []);
});

test('sweep: once an address exists it queues each order once, skipping cards and earlier scrapes', async () => {
  const { deps, queued } = sweepFake([O(1), O(2), O(3)], { email: true, cards: [2], commands: [3] });
  assert.deepEqual(await sweepLinkedOrders(deps), { queued: 1, waiting: 0, failed: 0 });
  assert.deepEqual(queued, [1]);
  assert.deepEqual(await sweepLinkedOrders(deps), { queued: 0, waiting: 0, failed: 0 });
});

test('sweep: one failing order does not stop the others', async () => {
  const { deps, queued } = sweepFake([O(1), O(2)], { email: true });
  const flaky: SweepDeps = { ...deps, hasCards: async id => { if (id === 1) throw new Error('db'); return false; } };
  assert.deepEqual(await sweepLinkedOrders(flaky), { queued: 1, waiting: 0, failed: 1 });
  assert.deepEqual(queued, [2]);
});
