// Adversarial repo-style test for: rt-amazon-buybox (tsx --test, tsconfig @/ paths)
// Property: parseAmazonBuyBox(html) => {soldBy, shippedBy, soldAndShippedByAmazon, price, currency}
// soldAndShippedByAmazon is true ONLY when BOTH ships-from AND sold-by are Amazon.com.
// Prime/FBA third-party (ships from Amazon, sold by a marketplace seller) MUST be false.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAmazonBuyBox } from '@/lib/amazonOffer';

// Amazon's modern tabular buy-box markup.
const tabular = (shipsFrom: string, soldBy: string, priceHtml = '<span class="a-offscreen">$1,299.00</span>') => `
<div id="tabular-buybox"><div class="tabular-buybox-container">
  <div class="tabular-buybox-text" tabular-attribute-name="Ships from"><span class="tabular-buybox-text-message">${shipsFrom}</span></div>
  <div class="tabular-buybox-text" tabular-attribute-name="Sold by"><span class="tabular-buybox-text-message">${soldBy}</span></div>
</div></div>
<div id="corePrice_feature_div"><span class="a-price">${priceHtml}</span></div>`;

test('sold AND shipped by Amazon.com => true, price parsed with comma', () => {
  const r = parseAmazonBuyBox(tabular('Amazon.com', 'Amazon.com'));
  assert.equal(r.soldAndShippedByAmazon, true);
  assert.equal(r.price, 1299);
  assert.equal(r.currency, 'USD');
});

test('OVER-TRIGGER GUARD: ships from Amazon.com but SOLD BY third-party (FBA/Prime) => false', () => {
  const r = parseAmazonBuyBox(tabular('Amazon.com', 'ACME Deals LLC'));
  assert.equal(r.soldAndShippedByAmazon, false);
  // it still reads the price and the real seller
  assert.equal(r.price, 1299);
});

test('ships from AND sold by third-party => false', () => {
  const r = parseAmazonBuyBox(tabular('ACME Deals LLC', 'ACME Deals LLC'));
  assert.equal(r.soldAndShippedByAmazon, false);
});

test('legacy combined phrase "Ships from and sold by Amazon.com" => true', () => {
  const html = '<div id="merchant-info">Ships from and sold by Amazon.com.</div><span class="a-offscreen">$49.99</span>';
  const r = parseAmazonBuyBox(html);
  assert.equal(r.soldAndShippedByAmazon, true);
  assert.equal(r.price, 49.99);
});

test('OVER-TRIGGER GUARD: "Amazon Warehouse" (used) is NOT Amazon.com => false', () => {
  const r = parseAmazonBuyBox(tabular('Amazon.com', 'Amazon Warehouse'));
  assert.equal(r.soldAndShippedByAmazon, false);
});

test('degenerate: empty / missing seller info does not throw, false + null price', () => {
  const r = parseAmazonBuyBox('<html><body>no offer here</body></html>');
  assert.equal(r.soldAndShippedByAmazon, false);
  assert.equal(r.price, null);
  assert.equal(r.soldBy, null);
});

test('degenerate: empty string input does not throw', () => {
  const r = parseAmazonBuyBox('');
  assert.equal(r.soldAndShippedByAmazon, false);
  assert.equal(r.price, null);
});
