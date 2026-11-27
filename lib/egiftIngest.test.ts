import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ingestEgiftDeliveries, countsLine, type IngestDeps, type CandidateOrder } from './egiftIngest.ts';
import type { EgiftDelivery } from './egiftDelivery.ts';

const D = (orderNumber = '000000001', recipient: string | null = 'buyer@example.com'): EgiftDelivery => ({
  link: 'https://www.memberedelivery.com/?login=SYNTHETICTOKEN', orderNumber, recipient,
});

function fake(orders: CandidateOrder[], init: Partial<{ links: number[]; emails: number[]; cards: number[]; commands: number[]; defaultEmail: boolean; reject: boolean; resolveTo: string | null }> = {}) {
  const st = { links: new Set(init.links ?? []), emails: new Set(init.emails ?? []), cards: new Set(init.cards ?? []), commands: new Set(init.commands ?? []), queued: [] as number[], saved: [] as string[], resolved: [] as string[] };
  const deps: IngestDeps = {
    findCostcoOrders: async d => orders.filter(o => (o.orderNumber ?? '').includes(d)),
    hasLink: async id => st.links.has(id),
    resolveTrackedLink: async urls => { st.resolved.push(...urls); return init.resolveTo === undefined ? 'https://www.memberedelivery.com/?login=RESOLVED' : init.resolveTo; },
    putLink: async (o, link) => { if (init.reject) return false; assert.ok(link.includes('login=')); st.links.add(o.id); return true; },
    hasOrderEmail: async id => st.emails.has(id),
    saveOrderEmail: async (id, e) => { st.emails.add(id); st.saved.push(e); },
    hasAnyEmail: async o => st.emails.has(o.id) || !!init.defaultEmail,
    hasCards: async id => st.cards.has(id),
    hasScrapeCommand: async id => st.commands.has(id),
    queueScrape: async id => { st.commands.add(id); st.queued.push(id); },
  };
  return { st, deps };
}
const ORDER: CandidateOrder = { id: 7, userId: 1, orderNumber: '000000001' };

test('stores link and address, queues one scrape, and a rerun does nothing more', async () => {
  const { st, deps } = fake([ORDER]);
  const c = await ingestEgiftDeliveries([D()], deps);
  assert.deepEqual([c.linksStored, c.emailsStored, c.queued], [1, 1, 1]);
  assert.deepEqual(st.queued, [7]);
  const again = await ingestEgiftDeliveries([D()], deps);
  assert.deepEqual([again.linksKept, again.emailsStored, again.queued, again.alreadyQueued], [1, 0, 0, 1]);
  assert.deepEqual(st.queued, [7]);
});

test('two emails for one order in a batch queue once', async () => {
  const { st, deps } = fake([ORDER]);
  await ingestEgiftDeliveries([D(), D()], deps);
  assert.deepEqual(st.queued, [7]);
});

test('an existing link is never overwritten and an existing order address is kept', async () => {
  const { st, deps } = fake([ORDER], { links: [7], emails: [7] });
  const c = await ingestEgiftDeliveries([D('000000001', 'other@example.com')], deps);
  assert.equal(c.linksKept, 1);
  assert.equal(c.linksStored, 0);
  assert.deepEqual(st.saved, []);
  assert.equal(c.queued, 1); // it still has no cards and no command
});

test('skips when the order already has cards, or a command exists in any state', async () => {
  const a = fake([ORDER], { cards: [7] });
  assert.equal((await ingestEgiftDeliveries([D()], a.deps)).hasCards, 1);
  assert.deepEqual(a.st.queued, []);
  const b = fake([ORDER], { commands: [7] });
  assert.equal((await ingestEgiftDeliveries([D()], b.deps)).alreadyQueued, 1);
  assert.deepEqual(b.st.queued, []);
});

test('no address anywhere: link saved, scrape not queued; the default address is enough', async () => {
  const a = fake([ORDER]);
  const c = await ingestEgiftDeliveries([D('000000001', null)], a.deps);
  assert.deepEqual([c.linksStored, c.noEmail, c.queued], [1, 1, 0]);
  const b = fake([ORDER], { defaultEmail: true });
  assert.equal((await ingestEgiftDeliveries([D('000000001', null)], b.deps)).queued, 1);
});

test('matching: no number, no order, ambiguous, other user', async () => {
  const { st, deps } = fake([ORDER, { id: 8, userId: 2, orderNumber: '000000002' }, { id: 9, userId: 1, orderNumber: '000000003' }, { id: 10, userId: 2, orderNumber: '000000003' }]);
  const c = await ingestEgiftDeliveries([D(''), D('999999999'), D('000000003')], deps);
  assert.deepEqual([c.noOrderNumber, c.noMatch, c.ambiguous, c.queued], [1, 1, 1, 0]);
  const mine = await ingestEgiftDeliveries([D('000000002')], deps, { userId: 1 });
  assert.equal(mine.noMatch, 1);
  assert.deepEqual(st.queued, []);
  // "0000000011" must not match order 000000001 by substring
  assert.equal((await ingestEgiftDeliveries([D('0000000011')], deps)).noMatch, 1);
});

test('a rejected link stops that order; an exception is counted, never rethrown or logged with text', async () => {
  const a = fake([ORDER], { reject: true });
  const c = await ingestEgiftDeliveries([D()], a.deps);
  assert.deepEqual([c.linksRejected, c.queued], [1, 0]);
  const { deps } = fake([ORDER]);
  deps.hasLink = async () => { throw new Error('boom https://www.memberedelivery.com/?login=SYNTHETICTOKEN'); };
  const f = await ingestEgiftDeliveries([D()], deps);
  assert.equal(f.failed, 1);
  const line = countsLine(f);
  assert.ok(!/SYNTHETIC|memberedelivery|@/.test(line));
});

const TRACKED = (orderNumber = '000000001'): EgiftDelivery => ({
  link: null, trackedLinks: ['https://link.memberedelivery.com/ls/click?upn=SYNTHETIC'], orderNumber, recipient: 'buyer@example.com',
});

test('a tracked-only email resolves the link, stores it and queues the scrape', async () => {
  const { st, deps } = fake([ORDER]);
  const c = await ingestEgiftDeliveries([TRACKED()], deps);
  assert.deepEqual([c.linksStored, c.linksUnresolved, c.queued], [1, 0, 1]);
  assert.equal(st.resolved.length, 1);
});

test('a tracked link is not followed when the order already has a link', async () => {
  const { st, deps } = fake([ORDER], { links: [7] });
  const c = await ingestEgiftDeliveries([TRACKED()], deps);
  assert.equal(c.linksKept, 1);
  assert.deepEqual(st.resolved, []);
});

test('an unresolvable tracked link stores no link and queues nothing, but keeps the address', async () => {
  const { st, deps } = fake([ORDER], { resolveTo: null });
  const c = await ingestEgiftDeliveries([TRACKED()], deps);
  assert.deepEqual([c.linksUnresolved, c.linksStored, c.emailsStored, c.queued], [1, 0, 1, 0]);
  assert.deepEqual(st.queued, []);
  assert.equal(st.links.has(7), false);
  assert.match(countsLine(c), /linksUnresolved=1/);
});
