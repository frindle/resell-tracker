'use strict';

const { test } = require('node:test');
const assert = require('assert');

const mod = require('./src/costcoEgiftRedemption.js');

// Every test starts by confirming parseRedemptionPage exists as a function
test('parseRedemptionPage is exported as a function', () => {
  assert.strictEqual(typeof mod.parseRedemptionPage, 'function');
});

test('plain title is extracted from order-item-title element', () => {
  assert.strictEqual(typeof mod.parseRedemptionPage, 'function');
  const html = `
    <html><body>
      <section class="order-item">
        <div class="order-item-title">My Gift Card</div>
      </section>
    </body></html>
  `;
  const result = mod.parseRedemptionPage(html, { openLabel: 'Access eGift' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.cards.length, 1);
  assert.strictEqual(result.cards[0].title, 'My Gift Card');
});

test('HTML entities are decoded in title text', () => {
  assert.strictEqual(typeof mod.parseRedemptionPage, 'function');
  const html = `
    <html><body>
      <section class="order-item">
        <div class="order-item-title">A &amp; B's &lt;special&gt; offer</div>
      </section>
    </body></html>
  `;
  const result = mod.parseRedemptionPage(html, { openLabel: 'Access eGift' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.cards[0].title, "A & B's <special> offer");
});

test('whitespace runs are collapsed and trimmed in title', () => {
  assert.strictEqual(typeof mod.parseRedemptionPage, 'function');
  const html = `
    <html><body>
      <section class="order-item">
        <div class="order-item-title">   lots   of    spaces   </div>
      </section>
    </body></html>
  `;
  const result = mod.parseRedemptionPage(html, { openLabel: 'Access eGift' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.cards[0].title, 'lots of spaces');
});

test('nested div inside the title element belongs to it', () => {
  assert.strictEqual(typeof mod.parseRedemptionPage, 'function');
  const html = `
    <html><body>
      <section class="order-item">
        <div class="order-item-title">Outer <div>inner</div> text</div>
      </section>
    </body></html>
  `;
  const result = mod.parseRedemptionPage(html, { openLabel: 'Access eGift' });
  assert.strictEqual(result.ok, true);
  // The nested <div> is inside the title element, so its text content is included
  assert.strictEqual(result.cards[0].title, 'Outer inner text');
});

test('unclosed title element yields empty string title', () => {
  assert.strictEqual(typeof mod.parseRedemptionPage, 'function');
  const html = `
    <html><body>
      <section class="order-item">
        <div class="order-item-title">Unclosed title
        <p>some other content</p>
      </section>
    </body></html>
  `;
  const result = mod.parseRedemptionPage(html, { openLabel: 'Access eGift' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.cards[0].title, '');
});

test('missing title element yields empty string', () => {
  assert.strictEqual(typeof mod.parseRedemptionPage, 'function');
  const html = `
    <html><body>
      <section class="order-item">
        <p>No title here</p>
      </section>
    </body></html>
  `;
  const result = mod.parseRedemptionPage(html, { openLabel: 'Access eGift' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.cards[0].title, '');
});

test('order-item-title-x is NOT matched (exact class token match)', () => {
  assert.strictEqual(typeof mod.parseRedemptionPage, 'function');
  const html = `
    <html><body>
      <section class="order-item">
        <div class="order-item-title-x">Wrong class</div>
      </section>
    </body></html>
  `;
  const result = mod.parseRedemptionPage(html, { openLabel: 'Access eGift' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.cards[0].title, '');
});

test('nbsp entity is decoded to space in title', () => {
  assert.strictEqual(typeof mod.parseRedemptionPage, 'function');
  const html = `
    <html><body>
      <section class="order-item">
        <div class="order-item-title">Hello&nbsp;World</div>
      </section>
    </body></html>
  `;
  const result = mod.parseRedemptionPage(html, { openLabel: 'Access eGift' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.cards[0].title, 'Hello World');
});

test('quot and apos entities are decoded in title', () => {
  assert.strictEqual(typeof mod.parseRedemptionPage, 'function');
  const html = `
    <html><body>
      <section class="order-item">
        <div class="order-item-title">He said &quot;hello&quot; &apos;goodbye&apos;</div>
      </section>
    </body></html>
  `;
  const result = mod.parseRedemptionPage(html, { openLabel: 'Access eGift' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.cards[0].title, 'He said "hello" \'goodbye\'');
});
