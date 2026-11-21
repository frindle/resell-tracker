import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkOrderFields, encodeChecks, decodeChecks, observationsOf, tally, buildReport, titlesAgree,
  BACKTEST_FIELDS, type OrderCheck, type Observation,
} from './amazonBacktest.ts';
import { ingestPage, type IngestDeps, type ImportRowLike, type LogEntry } from './amazonIngest.ts';
import type { ExistingOrder } from './amazonCompare.ts';
import type { ParsedOrder, ParsedPage } from './amazonPageParse.ts';

const ADDR = '100 Example St, Testville, ZZ 00000';
const page = (o: Partial<ParsedOrder> = {}): ParsedOrder => ({
  orderNumber: '111-2222222-3333331', orderDate: '2026-11-10', cost: 54.3, itemDescription: 'Widget Deluxe',
  shippingAddress: ADDR, trackingNumbers: ['TBA123456789012'], paymentLast4: '1234', paymentRatePercent: 6, taxAmount: 3.8, trackUrls: [], ...o,
});
const stored = (o: Partial<ExistingOrder> = {}): ExistingOrder => ({
  id: 1, orderNumber: '111-2222222-3333331', orderDate: new Date('2026-11-10T00:00:00Z'), cost: 54.3,
  itemDescription: 'Widget Deluxe', shippingAddress: ADDR, trackingNumbers: 'TBA123456789012',
  taxAmount: 3.8, cardId: 7, cardLast4s: ['1234'], noRushBonusPercent: null, locked: false, cancelled: false,
  userEditedFields: null, hasPhoto: true, ...o,
});
const ctx = { savedCardLast4s: new Set(['1234']) };

test('every field matches when page and tracker agree', () => {
  const c = checkOrderFields(page(), stored(), ctx)!;
  assert.deepEqual(Object.keys(c.fields).sort(), [...BACKTEST_FIELDS].sort());
  assert.ok(Object.values(c.fields).every(s => s === 'match'));
  assert.equal(c.mismatches.length, 0);
});

test('a differing value is a mismatch carrying stored and page values', () => {
  const c = checkOrderFields(page({ cost: 60, paymentLast4: '9999', taxAmount: 5 }), stored(), ctx)!;
  assert.equal(c.fields.cost, 'mismatch');
  assert.equal(c.fields.card, 'mismatch');
  assert.equal(c.fields.taxAmount, 'mismatch');
  assert.equal(c.fields.orderDate, 'match');
  const cost = c.mismatches.find(m => m.field === 'cost')!;
  assert.equal(cost.stored, 54.3);
  assert.equal(cost.page, 60);
});

test('blank tracker fields are filled-from-blank, never counted as match or mismatch', () => {
  const c = checkOrderFields(page(), stored({ trackingNumbers: null, taxAmount: null, cardId: null, shippingAddress: null, itemDescription: 'amazon.com' }), ctx)!;
  for (const f of ['trackingNumbers', 'taxAmount', 'card', 'shippingAddress', 'itemDescription'] as const) assert.equal(c.fields[f], 'filled', f);
  assert.equal(c.mismatches.length, 0);
});

test('fields the page did not supply are not recorded', () => {
  const c = checkOrderFields(page({ trackingNumbers: [], paymentLast4: undefined, taxAmount: null, shippingAddress: undefined }), stored(), ctx)!;
  assert.deepEqual(Object.keys(c.fields).sort(), ['cost', 'itemDescription', 'orderDate']);
});

test('hand-edited blank fields (no proposed fill) are skipped, not counted', () => {
  const c = checkOrderFields(page(), stored({ taxAmount: null, userEditedFields: JSON.stringify(['taxAmount']) }), ctx)!;
  assert.equal(c.fields.taxAmount, undefined);
});

test('unstored and locked orders are not checked', () => {
  assert.equal(checkOrderFields(page(), null, ctx), null);
  assert.equal(checkOrderFields(page({ cost: 99 }), stored({ locked: true }), ctx), null);
});

test('item titles compare loosely (truncation) but flag a different product', () => {
  assert.ok(titlesAgree('Widget Deluxe Edition 2-Pack', 'Widget Deluxe Edition'));
  assert.ok(!titlesAgree('Gadget Mini', 'Widget Deluxe'));
  assert.equal(checkOrderFields(page({ itemDescription: 'Other Thing' }), stored(), ctx)!.fields.itemDescription, 'mismatch');
});

test('storage round-trips and stays compact', () => {
  const checks: OrderCheck[] = [
    checkOrderFields(page({ cost: 60 }), stored(), ctx)!,
    checkOrderFields(page({ orderNumber: '111-2222222-3333332' }), stored({ taxAmount: null }), ctx)!,
  ];
  const json = encodeChecks(checks);
  assert.deepEqual(decodeChecks(json), checks);
  assert.ok(json.length < 600, `summary was ${json.length} chars`);
  assert.deepEqual(decodeChecks('not json'), []);
  assert.deepEqual(decodeChecks('{"v":1}'), []);
});

const obs = (n: number, field: Observation['field'], status: Observation['status'], day = 1, extra: Partial<Observation> = {}): Observation =>
  ({ at: new Date(Date.UTC(2026, 10, day)), orderNumber: `111-2222222-${String(3000000 + n)}`, field, status, ...extra });

test('report math: counts, percent, filled excluded from the denominator', () => {
  const list: Observation[] = [];
  for (let i = 0; i < 29; i++) list.push(obs(i, 'cost', 'match'));
  list.push(obs(29, 'cost', 'mismatch', 1, { stored: 10, page: 12 }));
  for (let i = 0; i < 5; i++) list.push(obs(100 + i, 'cost', 'filled'));
  const r = tally(list, { excludeEverFilled: true });
  const cost = r.fields.find(f => f.field === 'cost')!;
  assert.deepEqual([cost.checked, cost.matched, cost.mismatched, cost.filled], [30, 29, 1, 5]);
  assert.equal(cost.matchPercent, 96.7);
  assert.equal(cost.ok, false);
  assert.deepEqual(r.mismatches.map(m => [m.field, m.stored, m.page]), [['cost', 10, 12]]);
});

test('re-visiting an order counts once (latest result wins)', () => {
  const r = tally([obs(1, 'cost', 'mismatch', 1, { stored: 1, page: 2 }), obs(1, 'cost', 'match', 2), obs(1, 'cost', 'match', 3)], { excludeEverFilled: true });
  const cost = r.fields.find(f => f.field === 'cost')!;
  assert.deepEqual([cost.checked, cost.matched, cost.mismatched], [1, 1, 0]);
  assert.equal(r.mismatches.length, 0);
});

test('a value the page filled is not later counted as a match against itself', () => {
  const list = [obs(1, 'taxAmount', 'filled', 1), obs(1, 'taxAmount', 'match', 2)];
  const live = tally(list, { excludeEverFilled: true }).fields.find(f => f.field === 'taxAmount')!;
  assert.deepEqual([live.checked, live.filled], [0, 1]);
  const replay = tally(list, { excludeEverFilled: false }).fields.find(f => f.field === 'taxAmount')!;
  assert.deepEqual([replay.checked, replay.matched], [1, 1]);
});

const fullSet = (perField: number, bad: number, fieldsBad: string[] = []): Observation[] => {
  const out: Observation[] = [];
  BACKTEST_FIELDS.forEach((f, fi) => {
    for (let i = 0; i < perField; i++) {
      const isBad = fieldsBad.includes(f) && i < bad;
      out.push(obs(fi * 1000 + i, f, isBad ? 'mismatch' : 'match'));
    }
  });
  return out;
};

test('verdict: ready only with 30+ checked and 98%+ on every field', () => {
  assert.equal(tally(fullSet(30, 0), { excludeEverFilled: true }).ready, true);
  assert.equal(tally(fullSet(30, 0), { excludeEverFilled: true }).verdict.startsWith('ready'), true);
  // 29 checked on every field is not enough
  const few = tally(fullSet(29, 0), { excludeEverFilled: true });
  assert.equal(few.ready, false);
  assert.match(few.verdict, /^not ready: orderDate 29\/30 checked/);
  // 100 checked, 2 bad = 98% passes; 3 bad = 97% fails
  assert.equal(tally(fullSet(100, 2, ['cost']), { excludeEverFilled: true }).ready, true);
  const r3 = tally(fullSet(100, 3, ['cost']), { excludeEverFilled: true });
  assert.equal(r3.ready, false);
  assert.match(r3.verdict, /cost 97% match/);
  // one field short blocks the whole verdict
  const short = fullSet(30, 0).filter(o => o.field !== 'card' || o.orderNumber.endsWith('0'));
  assert.equal(tally(short, { excludeEverFilled: true }).ready, false);
});

test('buildReport reads stored summaries', () => {
  const rows = [
    { createdAt: new Date('2026-11-10T00:00:00Z'), summary: encodeChecks([checkOrderFields(page({ cost: 60 }), stored(), ctx)!]) },
    { createdAt: new Date('2026-11-11T00:00:00Z'), summary: encodeChecks([checkOrderFields(page({ orderNumber: '111-2222222-3333332' }), stored(), ctx)!]) },
    { createdAt: new Date('2026-11-12T00:00:00Z'), summary: 'garbage' },
  ];
  const r = buildReport(rows);
  assert.equal(r.pages, 3);
  const cost = r.fields.find(f => f.field === 'cost')!;
  assert.deepEqual([cost.checked, cost.matched, cost.mismatched], [2, 1, 1]);
  assert.equal(r.mismatches[0].orderNumber, '111-2222222-3333331');
  assert.equal(r.ready, false);
});

test('ingest records checks for matched orders too, and does not change what is written', async () => {
  const run = async (withRecorder: boolean) => {
    const rows: ImportRowLike[] = [], logs: LogEntry[] = [];
    const rec: { checks: OrderCheck[] } = { checks: [] };
    const deps: IngestDeps = {
      applyMode: true, now: new Date('2026-11-12T00:00:00Z'),
      loadExisting: async () => new Map([['11122222223333331', stored({ trackingNumbers: null })], ['11122222223333332', stored({ id: 2, orderNumber: '111-2222222-3333332' })]]),
      savedCardLast4s: async () => new Set(['1234']),
      importRows: async r => { rows.push(...r); },
      writeLog: async e => { logs.push(...e); },
      saveFailure: async () => {},
      ...(withRecorder ? { recordChecks: async (c: OrderCheck[]) => { rec.checks = c; } } : {}),
    };
    const parsed: ParsedPage = { kind: 'orders', blocked: false, orders: [page(), page({ orderNumber: '111-2222222-3333332' })] };
    const sum = await ingestPage(parsed, deps);
    return { sum, rows, logs, recorded: rec.checks };
  };
  const a = await run(true), b = await run(false);
  assert.deepEqual({ sum: a.sum, rows: a.rows, logs: a.logs }, { sum: b.sum, rows: b.rows, logs: b.logs });
  assert.equal(a.recorded.length, 2);
  const unchanged = a.recorded.find(c => c.orderNumber === '111-2222222-3333332')!;
  assert.ok(Object.values(unchanged.fields).every(s => s === 'match'), 'an unchanged order is still counted');
  assert.equal(a.recorded.find(c => c.orderNumber === '111-2222222-3333331')!.fields.trackingNumbers, 'filled');
  assert.ok(observationsOf(new Date(), a.recorded).length > 7);
});
