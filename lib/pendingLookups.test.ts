import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pendingLookupsFor, pendingLookupLabel } from './pendingLookups.ts';
import { AUTO_GIVE_UP_MS, AUTO_MAX_RUNS } from './amazonVisitPlan.ts';

const NOW = new Date('2026-01-10T12:00:00Z');
const NO = '111-0000000-0000001';
const entry = (o: object = {}) => ({ order: NO, stages: ['track'], done: [], autoTried: [], queuedAt: '2026-01-10T11:00:00Z', dueAt: '2026-01-10T13:00:00Z', ...o });
const st = (entries: object[], extra: object = {}) => JSON.stringify({ entries, ...extra });
const ord = (o: object = {}) => ({ orderNumber: NO, trackingNumbers: null, ...o });
const get = (json: string, orders = [ord()], stores: string[] = []) => pendingLookupsFor(json, orders, NOW, stores).get('11100000000000001');

test('track stage is a shipping scrape, detail only is an order scrape', () => {
  assert.equal(get(st([entry()]))?.kind, 'shipping');
  assert.equal(get(st([entry({ stages: ['detail'] })]))?.kind, 'order');
  assert.equal(get(st([entry({ stages: ['detail', 'track'] })]))?.kind, 'shipping');
});
test('digits matching ignores dashes and whitespace', () => {
  assert.ok(get(st([entry({ order: '111 0000000 0000001' })]), [ord({ orderNumber: '111-0000000-0000001' })]));
  assert.equal(get(st([entry({ order: '111-0000000-0000002' })])), undefined);
});
test('paused flag follows state.pausedAt', () => {
  assert.equal(get(st([entry()], { pausedAt: NOW.toISOString() }))?.paused, true);
  assert.equal(get(st([entry()]))?.paused, false);
});
test('order with tracking hides shipping but not order scrape', () => {
  assert.equal(get(st([entry()]), [ord({ trackingNumbers: '1Z999' })]), undefined);
  assert.ok(get(st([entry({ stages: ['detail'] })]), [ord({ trackingNumbers: '1Z999' })]));
});
test('no stages, cancelled, or missing order: nothing', () => {
  assert.equal(get(st([entry({ stages: [] })])), undefined);
  assert.equal(get(st([entry()]), [ord({ cancelled: true })]), undefined);
  assert.equal(get('garbage'), undefined);
});
test('gave up: too old or too many runs', () => {
  assert.equal(get(st([entry({ queuedAt: new Date(NOW.getTime() - AUTO_GIVE_UP_MS - 1000).toISOString() })]))?.gaveUp, true);
  assert.equal(get(st([entry({ autoRuns: AUTO_MAX_RUNS })]))?.gaveUp, true);
  assert.equal(get(st([entry({ autoRuns: 1 })]))?.gaveUp, false);
});
test('store lookups add order scrapes without a time', () => {
  const p = get('{}', [ord()], ['111-0000000-0000001']);
  assert.deepEqual(p, { kind: 'order', dueAt: null, paused: false, gaveUp: false });
});
test('labels', () => {
  const base = { kind: 'shipping' as const, dueAt: '2026-01-10T13:00:00Z', paused: false, gaveUp: false };
  const t = new Date(base.dueAt);
  const hh = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  assert.equal(pendingLookupLabel(base, 'long', NOW), `Shipping Scrape Scheduled ${hh}`);
  assert.equal(pendingLookupLabel(base, 'short', NOW), `Scrape Scheduled ${hh}`);
  assert.equal(pendingLookupLabel({ ...base, kind: 'order' }, 'long', NOW), `Order Scrape Scheduled ${hh}`);
  assert.equal(pendingLookupLabel({ ...base, dueAt: '2026-01-10T11:00:00Z' }, 'long', NOW), 'Shipping Scrape Due');
  assert.equal(pendingLookupLabel({ ...base, paused: true }, 'long', NOW), 'Shipping Scrape Paused: click Sync Amazon');
  assert.equal(pendingLookupLabel({ ...base, paused: true }, 'short', NOW), 'Scrape Paused');
  assert.equal(pendingLookupLabel({ ...base, gaveUp: true }, 'short', NOW), 'Scrape Gave Up');
});
