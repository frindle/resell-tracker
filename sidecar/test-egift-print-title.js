'use strict';
const { test } = require('node:test');
const assert = require('assert');
const mod = require('./src/costcoEgiftPrint.js');
const parse = (h, c) => mod.parsePrintPage(h, c);
const CODE = { code: 'Code:', pin: null };
const PAGER = '<span id="wdt-page-counter">1 of 3</span><input id="x-wdt-nav-next" type="button">';
// Wrap body in a fixture with pager, print-content-section, h2 and a next input.
const page = (body, pager) => '<html><body>' + (pager || PAGER) + '<div id="print-content-section"><h2>Gift</h2>' + body + '</div></body></html>';
const fail = (reason) => ({ ok: false, reason });

test('complete costco-style result', () => {
  assert.strictEqual(typeof mod.parsePrintPage, 'function');
  const html = '<html><body><span id="wdt-page-counter">2 of 3</span><input id="wdt-nav-next">' +
    '<div id="print-content-section"><h2 style="color:red">Costco  Shop &amp; Save $25</h2>' +
    '<table><tr><td>Code:</td><td><span>RETAIL10</span></td></tr><tr><td>PIN:</td><td><span>4455</span></td></tr></table></div></body></html>';
  assert.deepStrictEqual(parse(html, CO), { ok: true, index: 2, total: 3, done: false, code: 'RETAIL10', pin: '4455', title: 'Costco Shop & Save $25' });
});

const CO = { code: 'Code:', pin: 'PIN:' };

test('complete best buy-style result', () => {
  assert.strictEqual(typeof mod.parsePrintPage, 'function');
  const html = '<span id="wdt-page-counter">3 of 3</span><div id="print-content-section"><h2>Best Buy $50</h2>' +
    '<div>Card Number: <span>6001</span></div><div>PIN: 1234</div></div>';
  assert.deepStrictEqual(parse(html, { code: 'Card Number:', pin: 'PIN:' }), { ok: true, index: 3, total: 3, done: true, code: '6001', pin: '1234', title: 'Best Buy $50' });
});

test('h2 before print-content-section ignored; no h2 gives empty title', () => {
  assert.strictEqual(typeof mod.parsePrintPage, 'function');
  const pre = '<span id="wdt-page-counter">1 of 2</span><input id="wdt-nav-next"><h2>Header</h2>';
  assert.strictEqual(parse(pre + '<div id="print-content-section"><h2>Real</h2><p>Code: <span>C</span></p></div>', CODE).title, 'Real');
  assert.strictEqual(parse(pre + '<div id="print-content-section"><p>Code: <span>C</span></p></div>', CODE).title, '');
  assert.strictEqual(parse(pre.replace('<h2>Header</h2>', '') + '<div id="print-content-section"><p>Code: <span>C</span></p></div>', CODE).title, '');
});

test('entities and nested tags in h2, inline style irrelevant', () => {
  assert.strictEqual(typeof mod.parsePrintPage, 'function');
  const pre = '<span id="wdt-page-counter">1 of 2</span><input id="wdt-nav-next">';
  const h = pre + '<div id="print-content-section"><h2 style="font-size:1px">A &lt;b&gt; <b>bold</b>&nbsp;<i>it</i></h2><h2>second</h2><p>Code: <span>C</span></p></div>';
  assert.strictEqual(parse(h, CODE).title, 'A <b> bold it');
  const sq = pre + "<section id='print-content-section'><h2>Q</h2><p>Code: <span>C</span></p></section>";
  assert.strictEqual(parse(sq, CODE).title, 'Q');
});

test('failure results never echo code or pin', () => {
  assert.strictEqual(typeof mod.parsePrintPage, 'function');
  const pre = '<span id="wdt-page-counter">1 of 2</span><input id="wdt-nav-next"><div id="print-content-section"><h2>T</h2>';
  const r = parse(pre + '<p>Code: <span>SECRET</span></p></div>', CO);
  assert.deepStrictEqual(r, fail('no-pin'));
  assert.strictEqual(JSON.stringify(r).includes('SECRET'), false);
});
