'use strict';
const { test } = require('node:test');
const assert = require('assert');
const mod = require('./src/costcoEgiftRedemption.js');
const CFG = { openLabel: 'Access eGift', orderPrefix: null };
const parse = (h, c) => mod.parseRedemptionPage(h, c || CFG);

test('counter gives index and total', () => {
  assert.strictEqual(typeof mod.parseRedemptionPage, 'function');
  const r = parse('<section class="order-item"><p>2 of 5</p></section>');
  assert.deepStrictEqual(r, { ok: true, orderNumber: null, total: 5, cards: [{ index: 2, title: '', canOpen: false }] });
});

test('title counter does not win over the real counter', () => {
  assert.strictEqual(typeof mod.parseRedemptionPage, 'function');
  const r = parse('<section class="order-item"><div class="order-item-title">Deal 7 of 9</div><p>2 of 5</p></section>');
  assert.strictEqual(r.cards[0].index, 2);
  assert.strictEqual(r.total, 5);
  assert.strictEqual(r.cards[0].title, 'Deal 7 of 9');
});

test('title-only counter is ignored: position and card count used', () => {
  assert.strictEqual(typeof mod.parseRedemptionPage, 'function');
  const r = parse('<section class="order-item"><div class="order-item-title">Deal 7 of 9</div></section><section class="order-item"><p>x</p></section>');
  assert.deepStrictEqual(r.cards.map((c) => c.index), [1, 2]);
  assert.strictEqual(r.total, 2);
});

test('no counter: position and total = card count', () => {
  assert.strictEqual(typeof mod.parseRedemptionPage, 'function');
  const r = parse('<section class="order-item"><p>a</p></section><section class="order-item"><p>b</p></section><section class="order-item"><p>c</p></section>');
  assert.deepStrictEqual(r.cards.map((c) => c.index), [1, 2, 3]);
  assert.strictEqual(r.total, 3);
  assert.strictEqual(r.orderNumber, null);
});

test('first counter found decides total', () => {
  assert.strictEqual(typeof mod.parseRedemptionPage, 'function');
  const r = parse('<section class="order-item"><p>1 of 4</p></section><section class="order-item"><p>2 of 9</p></section>');
  assert.strictEqual(r.total, 4);
  assert.deepStrictEqual(r.cards.map((c) => c.index), [1, 2]);
});

test('counter split across tags and whitespace', () => {
  assert.strictEqual(typeof mod.parseRedemptionPage, 'function');
  const r = parse('<section class="order-item"><p>3\n of <b>8</b></p></section>');
  assert.strictEqual(r.cards[0].index, 3);
  assert.strictEqual(r.total, 8);
});
