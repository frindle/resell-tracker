import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isItemSummary } from './itemSummary.ts';

test('summaries: blank, store name, category and count, bare count, cut-off, category words only', () => {
  for (const s of [null, '', '  ', 'Amazon.com', 'Electronics (1 items)', 'Laptops, Electronics (3 items)', '2 items', 'Computers…', 'Computers...', 'Wireless mou…', 'Computers, Tablets', 'Home & Kitchen']) {
    assert.equal(isItemSummary(s), true, String(s));
  }
});

test('real item names are not summaries', () => {
  for (const s of ['USB-C cable 2 pack', 'Acme Widget 3000 Mini PC, 16GB', 'Home Theater Receiver X100', 'Desk lamp']) {
    assert.equal(isItemSummary(s), false, s);
  }
});
