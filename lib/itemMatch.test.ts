import test from 'node:test';
import assert from 'node:assert/strict';
import { pickByItem } from './itemMatch.ts';

const orders = [
  { id: 759, d: 'Apple AirPods Pro 3 Wireless Earbuds, Active Noise Cancellation' },
  { id: 772, d: 'Apple iPad Pro 11-inch (M5): Ultra Retina XDR Display, 256GB, Landscape 12MP' },
];
const d = (o: { d: string }) => o.d;

test('orders 759/772: iPad tracker row goes to the iPad order, AirPods row to the AirPods order', () => {
  assert.equal(pickByItem(orders, 'Apple iPad Pro - 11" 2025 M5 - 256gb - WiFi - Space Black - MDWK4LL/A', d)?.id, 772);
  assert.equal(pickByItem(orders, 'Apple AirPods Pro 3 - USB-C Charging Case - MFHP4LL/A', d)?.id, 759);
});
test('single candidate is returned unchanged; none returns undefined', () => {
  assert.equal(pickByItem([orders[0]], 'anything', d)?.id, 759);
  assert.equal(pickByItem([], 'x', d), undefined);
});
test('tie or no overlap: undefined (never guess)', () => {
  assert.equal(pickByItem(orders, 'Cash Bonus!', d), undefined);
  assert.equal(pickByItem([{ id: 1, d: 'iPad Pro' }, { id: 2, d: 'iPad Pro' }], 'iPad Pro', d), undefined);
});
