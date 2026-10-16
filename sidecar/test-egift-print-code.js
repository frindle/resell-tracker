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

test('invalid inputs', () => {
  assert.strictEqual(typeof mod.parsePrintPage, 'function');
  assert.deepStrictEqual(parse(5, CODE), fail('invalid-input'));
  assert.deepStrictEqual(parse(null, CODE), fail('invalid-input'));
  assert.deepStrictEqual(parse(page(''), undefined), fail('invalid-input'));
  assert.deepStrictEqual(parse(page(''), {}), fail('invalid-input'));
  assert.deepStrictEqual(parse(page(''), { code: 5 }), fail('invalid-input'));
  assert.deepStrictEqual(parse(page(''), [CODE]), fail('invalid-input'));
});

test('best buy style div/p block with inner span', () => {
  assert.strictEqual(typeof mod.parsePrintPage, 'function');
  const r = parse(page('<div>Code: <span>ABC123</span></div>'), CODE);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.code, 'ABC123');
  const r2 = parse(page('<p>code:<span> XY9 </span></p>'), CODE);
  assert.strictEqual(r2.code, 'XY9');
});

test('comment, script and style content ignored', () => {
  assert.strictEqual(typeof mod.parsePrintPage, 'function');
  const body = '<!-- <p>Code: <span>HIDDEN</span></p> --><script>var a = "<p>Code: <span>HIDDEN</span></p>";</script>' +
    '<style>/* <p>Code: <span>HIDDEN</span></p> */</style><p>Code: <span>REAL</span></p>';
  assert.strictEqual(parse(page(body), CODE).code, 'REAL');
  assert.deepStrictEqual(parse(page('<!-- <p>Code: <span>HIDDEN</span></p> -->'), CODE), fail('no-code'));
});

test('Promo Code / Barcode do not match Code:', () => {
  assert.strictEqual(typeof mod.parsePrintPage, 'function');
  assert.deepStrictEqual(parse(page('<p>Promo Code: <span>P1</span></p><p>Barcode: <span>B1</span></p>'), CODE), fail('no-code'));
  assert.strictEqual(parse(page('<p>Promo Code: <span>P1</span></p><p>Code: <span>C1</span></p>'), CODE).code, 'C1');
});

test('same value repeated ok, different values ambiguous, none no-code', () => {
  assert.strictEqual(typeof mod.parsePrintPage, 'function');
  assert.strictEqual(parse(page('<p>Code: <span>A1</span></p><div>Code: <span>A1</span></div>'), CODE).code, 'A1');
  assert.deepStrictEqual(parse(page('<p>Code: <span>A1</span></p><p>Code: <span>A2</span></p>'), CODE), fail('ambiguous-code'));
  assert.deepStrictEqual(parse(page('<p>nothing</p>'), CODE), fail('no-code'));
  assert.deepStrictEqual(parse(page('<p>Code: <span> </span></p>'), CODE), fail('no-code'));
});

test('entities decoded and outer wrappers are not leaf blocks', () => {
  assert.strictEqual(typeof mod.parsePrintPage, 'function');
  assert.strictEqual(parse(page('<p>Code: <span>A&amp;B</span></p>'), CODE).code, 'A&B');
  // the print-content-section wrapper contains everything but is not a leaf
  assert.strictEqual(parse(page('<div><div>Code: <span>N1</span></div></div>'), CODE).code, 'N1');
});

test('secrets only in success; failure has just ok and reason', () => {
  assert.strictEqual(typeof mod.parsePrintPage, 'function');
  const r = parse(page('<p>Code: <span>S1</span></p><p>Code: <span>S2</span></p>'), CODE);
  assert.deepStrictEqual(Object.keys(r), ['ok', 'reason']);
});
