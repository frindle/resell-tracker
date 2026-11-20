import test from 'node:test';
import assert from 'node:assert/strict';

import { merchantUrl } from './merchantUrl.ts';

// Synthetic order numbers only.

test('an Amazon order with no stored source URL still links to its order page', () => {
  assert.equal(merchantUrl('Amazon', '111-2222222-3333333', null),
    'https://www.amazon.com/gp/your-account/order-details?orderID=111-2222222-3333333');
});

test('a Walmart order with no stored source URL links without the hyphen', () => {
  assert.equal(merchantUrl('Walmart', '2000999-12345678', null), 'https://www.walmart.com/orders/200099912345678');
  assert.equal(merchantUrl('walmart', '2000999123456789', null), 'https://www.walmart.com/orders/2000999123456789');
});

test('a stored source URL wins over the built one', () => {
  assert.equal(merchantUrl('Walmart', '2000999-12345678', 'https://www.walmart.com/orders/x'), 'https://www.walmart.com/orders/x');
  assert.equal(merchantUrl('Newegg', '123456789', 'https://example.test/o/1'), 'https://example.test/o/1');
});

test('a leading # and spaces are dropped', () => {
  assert.equal(merchantUrl(' Amazon ', ' #111-2222222-3333333 ', null),
    'https://www.amazon.com/gp/your-account/order-details?orderID=111-2222222-3333333');
});

test('Costco links only online orders', () => {
  assert.equal(merchantUrl('Costco', '1234567890', null), null);
  assert.match(merchantUrl('Costco', '1234567890', 'https://www.costco.com/x') ?? '', /orderdetails\/1234567890$/);
});

test('no number, or a store with no known order page, gives no link', () => {
  assert.equal(merchantUrl('Amazon', null, null), null);
  assert.equal(merchantUrl('Walmart', '  ', null), null);
  assert.equal(merchantUrl('Newegg', '123456789', null), null);
  assert.equal(merchantUrl('Best Buy', 'BBY01-000000000000', null), null);
});
