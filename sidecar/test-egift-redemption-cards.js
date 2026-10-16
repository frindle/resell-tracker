'use strict';

const { test } = require('node:test');
const assert = require('assert');

const mod = require('./src/costcoEgiftRedemption.js');

// Every test starts by confirming parseRedemptionPage exists as a function
test('parseRedemptionPage is exported as a function', () => {
  assert.strictEqual(typeof mod.parseRedemptionPage, 'function');
});

test('invalid html input returns invalid-input', () => {
  assert.strictEqual(typeof mod.parseRedemptionPage, 'function');
  // non-string html
  assert.deepStrictEqual(mod.parseRedemptionPage(123, {}), { ok: false, reason: 'invalid-input' });
  assert.deepStrictEqual(mod.parseRedemptionPage(null, {}), { ok: false, reason: 'invalid-input' });
  assert.deepStrictEqual(mod.parseRedemptionPage(undefined, {}), { ok: false, reason: 'invalid-input' });
  assert.deepStrictEqual(mod.parseRedemptionPage([], {}), { ok: false, reason: 'invalid-input' });
});

test('missing or bad cfg returns invalid-input', () => {
  assert.strictEqual(typeof mod.parseRedemptionPage, 'function');
  // missing cfg
  assert.deepStrictEqual(mod.parseRedemptionPage('<html></html>', null), { ok: false, reason: 'invalid-input' });
  assert.deepStrictEqual(mod.parseRedemptionPage('<html></html>'), { ok: false, reason: 'invalid-input' });
  // cfg is an array
  assert.deepStrictEqual(mod.parseRedemptionPage('<html></html>', [1]), { ok: false, reason: 'invalid-input' });
  // non-string openLabel
  assert.deepStrictEqual(mod.parseRedemptionPage('<html></html>', { openLabel: 42 }), { ok: false, reason: 'invalid-input' });
  assert.deepStrictEqual(mod.parseRedemptionPage('<html></html>', { openLabel: true }), { ok: false, reason: 'invalid-input' });
});

test('zero cards returns no-cards when no alert present', () => {
  assert.strictEqual(typeof mod.parseRedemptionPage, 'function');
  const html = '<html><body><p>No cards here</p></body></html>';
  const result = mod.parseRedemptionPage(html, { openLabel: 'Access eGift' });
  assert.deepStrictEqual(result, { ok: false, reason: 'no-cards' });
});

test('comments and script/style are removed before card detection', () => {
  assert.strictEqual(typeof mod.parseRedemptionPage, 'function');
  // A card inside a comment should be ignored
  const html = `
    <html>
      <body>
        <!-- <section class="order-item"><p>Hidden card</p></section> -->
        <script>var x = '<section class="order-item">Script card</section>';</script>
        <style>.x { content: '<section class="order-item">Style card</section>'; }</style>
      </body>
    </html>
  `;
  const result = mod.parseRedemptionPage(html, { openLabel: 'Access eGift' });
  assert.deepStrictEqual(result, { ok: false, reason: 'no-cards' });
});

test('a real card after ignored markup returns total=1 and cards.length=1', () => {
  assert.strictEqual(typeof mod.parseRedemptionPage, 'function');
  const html = `
    <html>
      <body>
        <!-- <section class="order-item"><p>Hidden</p></section> -->
        <script>var x = '<section class="order-item">Ignored</section>';</script>
        <section class="order-item"><p>Real card</p></section>
      </body>
    </html>
  `;
  const result = mod.parseRedemptionPage(html, { openLabel: 'Access eGift' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.total, 1);
  assert.strictEqual(result.cards.length, 1);
  assert.strictEqual(result.cards[0].index, 1);
  assert.strictEqual(result.cards[0].title, '');
  assert.strictEqual(result.cards[0].canOpen, false);
});

test('reorder-item and order-item-extra are NOT cards', () => {
  assert.strictEqual(typeof mod.parseRedemptionPage, 'function');
  const html = `
    <html>
      <body>
        <section class="reorder-item"><p>Not a card</p></section>
        <section class="order-item-extra"><p>Also not a card</p></section>
      </body>
    </html>
  `;
  const result = mod.parseRedemptionPage(html, { openLabel: 'Access eGift' });
  assert.deepStrictEqual(result, { ok: false, reason: 'no-cards' });
});

test('a single order-item card beside reorder-item counts only the real one', () => {
  assert.strictEqual(typeof mod.parseRedemptionPage, 'function');
  const html = `
    <html>
      <body>
        <section class="reorder-item"><p>Not a card</p></section>
        <section class="order-item"><p>Real card</p></section>
      </body>
    </html>
  `;
  const result = mod.parseRedemptionPage(html, { openLabel: 'Access eGift' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.cards.length, 1);
  assert.strictEqual(result.total, 1);
});

test('a > inside a quoted attribute value does not end the tag', () => {
  assert.strictEqual(typeof mod.parseRedemptionPage, 'function');
  const html = `
    <html>
      <body>
        <section class="order-item" data-filter="a>b"><p>Card with quoted > in attr</p></section>
      </body>
    </html>
  `;
  const result = mod.parseRedemptionPage(html, { openLabel: 'Access eGift' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.cards.length, 1);
  assert.strictEqual(result.total, 1);
});

test('nested section inside a card does not end it early', () => {
  assert.strictEqual(typeof mod.parseRedemptionPage, 'function');
  const html = `
    <html>
      <body>
        <section class="order-item">
          <p>Outer card text</p>
          <section class="nested"><p>Nested section</p></section>
          <p>More outer text</p>
        </section>
      </body>
    </html>
  `;
  const result = mod.parseRedemptionPage(html, { openLabel: 'Access eGift' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.cards.length, 1);
  assert.strictEqual(result.total, 1);
});

test('two cards in document order have index 1 and 2', () => {
  assert.strictEqual(typeof mod.parseRedemptionPage, 'function');
  const html = `
    <html>
      <body>
        <section class="order-item"><p>First card</p></section>
        <section class="order-item"><p>Second card</p></section>
      </body>
    </html>
  `;
  const result = mod.parseRedemptionPage(html, { openLabel: 'Access eGift' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.cards.length, 2);
  assert.strictEqual(result.cards[0].index, 1);
  assert.strictEqual(result.cards[1].index, 2);
});

test('alert div with non-empty text returns reason alert', () => {
  assert.strictEqual(typeof mod.parseRedemptionPage, 'function');
  const html = `
    <html>
      <body>
        <div class="ui-message" role="alert">Something went wrong</div>
      </body>
    </html>
  `;
  const result = mod.parseRedemptionPage(html, { openLabel: 'Access eGift' });
  assert.deepStrictEqual(result, { ok: false, reason: 'alert' });
});

test('blank alert div returns no-cards', () => {
  assert.strictEqual(typeof mod.parseRedemptionPage, 'function');
  const html = `
    <html>
      <body>
        <div class="ui-message" role="alert">   </div>
      </body>
    </html>
  `;
  const result = mod.parseRedemptionPage(html, { openLabel: 'Access eGift' });
  assert.deepStrictEqual(result, { ok: false, reason: 'no-cards' });
});

test('alert div without role alert does not trigger alert path', () => {
  assert.strictEqual(typeof mod.parseRedemptionPage, 'function');
  const html = `
    <html>
      <body>
        <div class="ui-message">Just a message, not an alert</div>
      </body>
    </html>
  `;
  const result = mod.parseRedemptionPage(html, { openLabel: 'Access eGift' });
  assert.deepStrictEqual(result, { ok: false, reason: 'no-cards' });
});

test('section.fraud-warning is never a card', () => {
  assert.strictEqual(typeof mod.parseRedemptionPage, 'function');
  const html = `
    <html>
      <body>
        <section class="fraud-warning"><p>Fraud warning</p></section>
      </body>
    </html>
  `;
  const result = mod.parseRedemptionPage(html, { openLabel: 'Access eGift' });
  assert.deepStrictEqual(result, { ok: false, reason: 'no-cards' });
});

test('orderNumber is extracted from page text', () => {
  assert.strictEqual(typeof mod.parseRedemptionPage, 'function');
  const html = `
    <html>
      <body>
        <p>Order Number: ABC-123</p>
        <section class="order-item"><p>Card</p></section>
      </body>
    </html>
  `;
  const result = mod.parseRedemptionPage(html, { openLabel: 'Access eGift' });
  assert.strictEqual(result.orderNumber, 'ABC-123');
});

test('orderNumber filtered by prefix returns null when mismatched', () => {
  assert.strictEqual(typeof mod.parseRedemptionPage, 'function');
  const html = `
    <html>
      <body>
        <p>Order Number: XYZ-123</p>
        <section class="order-item"><p>Card</p></section>
      </body>
    </html>
  `;
  const result = mod.parseRedemptionPage(html, { openLabel: 'Access eGift', orderPrefix: 'ABC-' });
  assert.strictEqual(result.orderNumber, null);
});

test('orderNumber is null when no match', () => {
  assert.strictEqual(typeof mod.parseRedemptionPage, 'function');
  const html = `
    <html>
      <body>
        <section class="order-item"><p>Card</p></section>
      </body>
    </html>
  `;
  const result = mod.parseRedemptionPage(html, { openLabel: 'Access eGift' });
  assert.strictEqual(result.orderNumber, null);
});
