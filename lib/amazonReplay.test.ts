import test from 'node:test';
import assert from 'node:assert/strict';
import { replayPage, replayReport } from './amazonReplay.ts';
import type { ExistingOrder } from './amazonCompare.ts';
import type { ParsedOrder, ParsedPage } from './amazonPageParse.ts';

const ADDR = '100 Example St, Testville, ZZ 00000';
const page = (o: Partial<ParsedOrder> = {}): ParsedOrder => ({
  orderNumber: '111-2222222-3333331', orderDate: '2026-11-10', cost: 54.3, itemDescription: 'Widget Deluxe',
  shippingAddress: ADDR, trackingNumbers: ['TBA123456789012'], paymentLast4: '1234', taxAmount: 3.8, trackUrls: [], ...o,
});
const stored = (o: Partial<ExistingOrder> = {}): ExistingOrder => ({
  id: 1, orderNumber: '111-2222222-3333331', orderDate: new Date('2026-11-10T00:00:00Z'), cost: 54.3,
  itemDescription: 'Widget Deluxe', shippingAddress: ADDR, trackingNumbers: 'TBA123456789012',
  taxAmount: 3.8, cardId: 7, cardLast4s: ['1234'], noRushBonusPercent: null, locked: false, cancelled: false,
  userEditedFields: null, hasPhoto: true, ...o,
});
const ctx = { savedCardLast4s: new Set(['1234']) };
const at = new Date('2026-11-12T00:00:00Z');
const parsedPage = (orders: ParsedOrder[], extra: Partial<ParsedPage> = {}): ParsedPage => ({ kind: 'orders', blocked: false, orders, ...extra });

test('replay diffs the re-parsed page against current stored values', () => {
  const existing = new Map([['11122222223333331', stored()]]);
  // "old parser" output agrees; a changed parser that misreads the total does not
  const before = replayReport(replayPage(at, parsedPage([page()]), existing, ctx));
  assert.equal(before.fields.find(f => f.field === 'cost')!.mismatched, 0);
  const after = replayReport(replayPage(at, parsedPage([page({ cost: 5.43 })]), existing, ctx));
  assert.equal(after.fields.find(f => f.field === 'cost')!.mismatched, 1);
  assert.deepEqual(after.mismatches.map(m => [m.orderNumber, m.field, m.stored, m.page]), [['111-2222222-3333331', 'cost', 54.3, 5.43]]);
});

test('replay uses the latest page per order, ignores unknown orders, blocked and failed pages', () => {
  const existing = new Map([['11122222223333331', stored()]]);
  const obs = [
    ...replayPage(new Date('2026-11-10T00:00:00Z'), parsedPage([page({ cost: 1 })]), existing, ctx),
    ...replayPage(new Date('2026-11-11T00:00:00Z'), parsedPage([page()]), existing, ctx),
    ...replayPage(at, parsedPage([page({ orderNumber: '111-2222222-9999999' })]), existing, ctx),
    ...replayPage(at, parsedPage([], { blocked: true }), existing, ctx),
    ...replayPage(at, parsedPage([], { parseFailed: true }), existing, ctx),
  ];
  const r = replayReport(obs);
  const cost = r.fields.find(f => f.field === 'cost')!;
  assert.deepEqual([cost.checked, cost.matched, cost.mismatched], [1, 1, 0]);
});

test('replay reports blank tracker fields separately instead of as matches', () => {
  const existing = new Map([['11122222223333331', stored({ taxAmount: null })]]);
  const r = replayReport(replayPage(at, parsedPage([page()]), existing, ctx));
  const tax = r.fields.find(f => f.field === 'taxAmount')!;
  assert.deepEqual([tax.checked, tax.filled], [0, 1]);
});
