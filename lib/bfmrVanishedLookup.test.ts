import test from 'node:test';
import assert from 'node:assert/strict';
import { vanishedLookupFilter } from './bfmrVanished.ts';

test('vanishedLookupFilter returns { orders: [orderId], page_size: 200 }', () => {
  const result = vanishedLookupFilter('WN70595435');
  assert.deepStrictEqual(result, { orders: ['WN70595435'], page_size: 200 });
});

test('vanishedLookupFilter trims whitespace from orderId', () => {
  const result = vanishedLookupFilter(' 111-2213508-9161019 ');
  assert.deepStrictEqual(result.orders, ['111-2213508-9161019']);
  assert.strictEqual(result.page_size, 200);
});

test('vanishedLookupFilter result has no search key', () => {
  const r = vanishedLookupFilter('TEST123');
  assert.strictEqual('search' in r, false);
});

test('vanishedLookupFilter throws on empty orderId after trimming', () => {
  assert.throws(() => vanishedLookupFilter('  '), /empty orderId/);
});

test('two calls return distinct objects', () => {
  const a = vanishedLookupFilter('AAA');
  const b = vanishedLookupFilter('BBB');
  assert.notStrictEqual(a, b);
  // Also verify they are not the same reference even for the same input
  const c = vanishedLookupFilter('AAA');
  assert.notStrictEqual(a, c);
});
