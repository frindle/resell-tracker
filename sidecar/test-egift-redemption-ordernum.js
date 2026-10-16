'use strict';
const { test } = require('node:test');
const assert = require('assert');
const mod = require('./src/costcoEgiftRedemption.js');
const CFG = { openLabel: 'Access eGift', orderPrefix: null };
const parse = (h, c) => mod.parseRedemptionPage(h, c || CFG);

const CARD = '<section class="order-item"><p>x</p></section>';

test('order number found', () => {
  assert.strictEqual(typeof mod.parseRedemptionPage, 'function');
  assert.deepStrictEqual(parse('<p>Order Number: ABC-123</p>' + CARD), { ok: true, orderNumber: 'ABC-123', total: 1, cards: [{ index: 1, title: '', canOpen: false }] });
});

test('order number null when absent', () => {
  assert.strictEqual(typeof mod.parseRedemptionPage, 'function');
  assert.strictEqual(parse(CARD).orderNumber, null);
});

test('order number inside a tag is found across markup', () => {
  assert.strictEqual(typeof mod.parseRedemptionPage, 'function');
  assert.strictEqual(parse('<p>Order Number: <b>ZZ9</b></p><p>Next</p>' + CARD).orderNumber, 'ZZ9');
});

test('orderPrefix mismatch gives null, match is kept', () => {
  assert.strictEqual(typeof mod.parseRedemptionPage, 'function');
  const cfg = { openLabel: 'Access eGift', orderPrefix: 'BBY01-' };
  assert.strictEqual(parse('<p>Order Number: XYZ-1</p>' + CARD, cfg).orderNumber, null);
  assert.strictEqual(parse('<p>Order Number: BBY01-77</p>' + CARD, cfg).orderNumber, 'BBY01-77');
});

test('first match wins', () => {
  assert.strictEqual(typeof mod.parseRedemptionPage, 'function');
  assert.strictEqual(parse('<p>Order Number: A1</p><p>Order Number: B2</p>' + CARD).orderNumber, 'A1');
});

test('order number in comment or script is ignored', () => {
  assert.strictEqual(typeof mod.parseRedemptionPage, 'function');
  const html = '<!-- Order Number: HID1 --><script>var s="Order Number: HID2";</script><p>Order Number: REAL3</p>' + CARD;
  assert.strictEqual(parse(html).orderNumber, 'REAL3');
  assert.strictEqual(parse('<!-- Order Number: HID1 -->' + CARD).orderNumber, null);
});

test('failure result never carries the order number', () => {
  assert.strictEqual(typeof mod.parseRedemptionPage, 'function');
  assert.deepStrictEqual(parse('<p>Order Number: SECRET1</p>'), { ok: false, reason: 'no-cards' });
});
