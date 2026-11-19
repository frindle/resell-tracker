import { test } from 'node:test';
import assert from 'node:assert/strict';
import { couldNotGet, failureKey, failureLine, planFillPush, rememberKeys, type FillFailure } from './fillFailureAlert.ts';
import type { GapOrder } from './gapFill.ts';

const ADDR = '100 Test St, Springfield, ZZ, 00001, USA';
const o = (x: Partial<GapOrder>): GapOrder => ({
  platform: 'Walmart', orderNumber: '1000000000001', itemDescription: 'Thing', shippingAddress: ADDR, trackingNumbers: null, shipped: false, cardId: 3, ...x,
});

test('couldNotGet: a finished fetch that left a gap is a failure, naming the gap', () => {
  const out = couldNotGet(
    [{ status: 'done', orderNumbers: ['1000000000001'] }, { status: 'failed', orderNumbers: ['1000000000002'] }],
    [o({ itemDescription: '', cardId: null }), o({ orderNumber: '1000000000002', shippingAddress: null })],
  );
  assert.deepEqual(out, [
    { kind: 'get', orderNumber: '1000000000001', missing: ['item', 'card'] },
    { kind: 'get', orderNumber: '1000000000002', missing: ['address'] },
  ]);
});

test('couldNotGet: filled orders, running commands and tracking-only gaps are not failures', () => {
  assert.deepEqual(couldNotGet([{ status: 'done', orderNumbers: ['1000000000001'] }], [o({})]), []);
  assert.deepEqual(couldNotGet([{ status: 'pending', orderNumbers: ['1000000000001'] }, { status: 'running', orderNumbers: ['1000000000001'] }], [o({ itemDescription: '' })]), []);
  // No tracking email yet, and no shipped flag later: not a missing field.
  assert.deepEqual(couldNotGet([{ status: 'done', orderNumbers: ['1000000000001'] }], [o({ trackingNumbers: null })]), []);
  // Unknown order numbers and stores without a scraper are skipped.
  assert.deepEqual(couldNotGet([{ status: 'failed', orderNumbers: ['999'] }], [o({})]), []);
  assert.deepEqual(couldNotGet([{ status: 'failed', orderNumbers: ['1000000000001'] }], [o({ platform: 'Lenovo', itemDescription: '' })]), []);
});

test('couldNotGet: one entry per order across commands', () => {
  const out = couldNotGet(
    [{ status: 'failed', orderNumbers: ['1000000000001'] }, { status: 'done', orderNumbers: ['1000000000001'] }],
    [o({ itemDescription: '' })],
  );
  assert.equal(out.length, 1);
});

test('failureKey: stable per order, kind and what is wrong', () => {
  assert.equal(failureKey({ kind: 'get', orderNumber: '100-0001', missing: ['card', 'item'] }), failureKey({ kind: 'get', orderNumber: '1000001', missing: ['item', 'card'] }));
  assert.notEqual(failureKey({ kind: 'get', orderNumber: '1', missing: ['item'] }), failureKey({ kind: 'get', orderNumber: '1', missing: ['item', 'card'] }));
  assert.notEqual(failureKey({ kind: 'link', orderNumber: '1', reason: 'none' }), failureKey({ kind: 'link', orderNumber: '1', reason: 'several' }));
});

test('planFillPush: nothing to say is no push', () => {
  assert.deepEqual(planFillPush([], new Set()), { text: null, keys: [] });
});

test('planFillPush: one batched note, and the same issue is never told twice', () => {
  const a: FillFailure = { kind: 'get', orderNumber: '1000000000001', missing: ['item'] };
  const b: FillFailure = { kind: 'link', orderNumber: '1000000000002', reason: 'several' };
  const first = planFillPush([a, b, a], new Set());
  assert.equal(first.keys.length, 2);
  assert.equal(first.text, '2 orders need a look\nOrder 1000000000001: could not get item\nOrder 1000000000002: could not link, several open items match');
  const again = planFillPush([a, b], new Set(first.keys));
  assert.deepEqual(again, { text: null, keys: [] });
  // A new problem on the same order is new.
  const c: FillFailure = { kind: 'get', orderNumber: '1000000000001', missing: ['item', 'card'] };
  assert.equal(planFillPush([a, c], new Set(first.keys)).keys.length, 1);
});

test('planFillPush: a long list is cut and counted', () => {
  const many: FillFailure[] = Array.from({ length: 8 }, (_, i) => ({ kind: 'link', orderNumber: `100${i}`, reason: 'none' as const }));
  const p = planFillPush(many, new Set());
  assert.equal(p.keys.length, 8);
  const lines = p.text!.split('\n');
  assert.equal(lines[0], '8 orders need a look');
  assert.equal(lines.length, 7);
  assert.equal(lines[6], 'and 3 more');
  assert.equal(planFillPush([many[0]], new Set()).text!.split('\n')[0], '1 order needs a look');
});

test('failureLine and rememberKeys', () => {
  assert.equal(failureLine({ kind: 'link', orderNumber: '7', reason: 'too-many' }), 'Order 7: could not link, more units than any match has left');
  assert.deepEqual(rememberKeys(['a', 'b'], ['c'], 2), ['b', 'c']);
});
