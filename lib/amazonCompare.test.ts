import test from 'node:test';
import assert from 'node:assert/strict';
import { compareOrder, type ExistingOrder } from './amazonCompare.ts';
import { ingestPage, type IngestDeps, type ImportRowLike } from './amazonIngest.ts';
import type { ParsedOrder, ParsedPage } from './amazonPageParse.ts';

const page = (o: Partial<ParsedOrder> = {}): ParsedOrder => ({
  orderNumber: '111-2222222-3333331', orderDate: '2026-11-10', cost: 54.3, itemDescription: 'Widget',
  shippingAddress: '100 Example St, Testville, ZZ 00000', trackingNumbers: ['TBA123456789012'],
  paymentLast4: '1234', paymentRatePercent: 6, taxAmount: 3.8, trackUrls: [], ...o,
});
const stored = (o: Partial<ExistingOrder> = {}): ExistingOrder => ({
  id: 1, orderNumber: '111-2222222-3333331', orderDate: new Date('2026-11-10T00:00:00Z'), cost: 54.3,
  itemDescription: 'Widget', shippingAddress: '100 Example St, Testville, ZZ 00000', trackingNumbers: 'TBA123456789012',
  taxAmount: 3.8, cardId: 7, cardLast4s: ['1234'], noRushBonusPercent: null, locked: false, cancelled: false,
  userEditedFields: null, hasPhoto: true, ...o,
});
const ctx = { savedCardLast4s: new Set(['1234']) };

test('create when not stored', () => {
  assert.equal(compareOrder(page(), null, ctx).action, 'create');
});
test('page without cost cannot be created: incomplete', () => {
  assert.equal(compareOrder(page({ cost: undefined }), null, ctx).action, 'incomplete');
});
test('fill only blank fields', () => {
  const a = compareOrder(page(), stored({ trackingNumbers: null, taxAmount: null, cardId: null }), ctx);
  assert.equal(a.action, 'fill');
  assert.deepEqual(a.changes.map(c => c.field).sort(), ['cardId', 'taxAmount', 'trackingNumbers']);
  assert.equal(a.discrepancies.length, 0);
});
test('differing stored values are discrepancies, never changes', () => {
  const a = compareOrder(page({ cost: 60, shippingAddress: '9 Other Rd, Elsewhere, ZZ 11111', paymentLast4: '9999', trackingNumbers: ['TBA999999999999'] }), stored(), ctx);
  assert.equal(a.action, 'unchanged');
  assert.deepEqual(a.discrepancies.map(d => d.field).sort(), ['card', 'cost', 'shippingAddress', 'trackingNumbers']);
});
test('locked orders are left alone', () => {
  const a = compareOrder(page(), stored({ locked: true, trackingNumbers: null }), ctx);
  assert.equal(a.action, 'locked'); assert.equal(a.changes.length, 0);
});
test('user-edited fields are not filled', () => {
  const a = compareOrder(page(), stored({ trackingNumbers: null, userEditedFields: JSON.stringify(['trackingNumbers']) }), ctx);
  assert.equal(a.changes.some(c => c.field === 'trackingNumbers'), false);
});

function makeDeps(apply: boolean, existing: ExistingOrder | null) {
  const calls = { imported: [] as ImportRowLike[][], logs: 0, failures: 0 };
  const deps: IngestDeps = {
    applyMode: apply, now: new Date('2026-11-14T12:00:00Z'),
    loadExisting: async () => new Map(existing ? [['11122222223333331', existing]] : []),
    savedCardLast4s: async () => new Set(['1234']),
    importRows: async rows => { calls.imported.push(rows); },
    writeLog: async e => { calls.logs += e.length; },
    saveFailure: async () => { calls.failures++; },
  };
  return { deps, calls };
}
const parsed = (orders: ParsedOrder[], kind: ParsedPage['kind'] = 'detail'): ParsedPage => ({ kind, blocked: false, orders });

test('compare-only writes nothing but the log', async () => {
  const { deps, calls } = makeDeps(false, null);
  const s = await ingestPage(parsed([page()]), deps);
  assert.equal(s.mode, 'compare'); assert.equal(s.created, 1);
  assert.equal(calls.imported.length, 0);
  assert.equal(calls.logs, 1);
});
test('apply mode sends one import row through the import path', async () => {
  const { deps, calls } = makeDeps(true, null);
  await ingestPage(parsed([page()]), deps);
  assert.equal(calls.imported.length, 1);
  assert.equal(calls.imported[0][0].platform, 'Amazon');
  assert.equal(calls.imported[0][0].cost, 54.3);
});
test('apply fill sends only blank fields plus stored cost/date', async () => {
  const { deps, calls } = makeDeps(true, stored({ trackingNumbers: null }));
  await ingestPage(parsed([page()]), deps);
  const row = calls.imported[0][0];
  assert.deepEqual(row.trackingNumbers, ['TBA123456789012']);
  assert.equal(row.shippingAddress, undefined);
});
test('blocked page: nothing parsed, nothing written', async () => {
  const { deps, calls } = makeDeps(true, null);
  const s = await ingestPage({ kind: 'orders', blocked: true, orders: [] }, deps);
  assert.equal(s.blocked, true); assert.equal(calls.logs, 0); assert.equal(calls.imported.length, 0);
});
test('parse failure is saved, not imported', async () => {
  const { deps, calls } = makeDeps(true, null);
  const s = await ingestPage({ kind: 'detail', blocked: false, orders: [], parseFailed: true }, deps);
  assert.equal(s.parseFailed, true); assert.equal(calls.failures, 1);
});
test('list page reports needs and window', async () => {
  const { deps } = makeDeps(false, null);
  const s = await ingestPage({ ...parsed([page({ detailUrl: 'https://www.amazon.com/x' })], 'orders'), oldestDate: '2026-10-01', nextUrl: 'https://www.amazon.com/next' }, deps);
  assert.equal(s.list?.reachedWindow, true);
  assert.equal(s.list?.needs.length, 1);
  assert.equal(s.list?.allComplete, false);
});
