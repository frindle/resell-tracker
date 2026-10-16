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

const row = (cells) => '<table><tr>' + cells + '</tr></table>';

test('costco label cell plus next cell span', () => {
  assert.strictEqual(typeof mod.parsePrintPage, 'function');
  const r = parse(page(row('<td>Code:</td><td><span>RETAIL10</span></td>')), CODE);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.code, 'RETAIL10');
});

test('th label with td value', () => {
  assert.strictEqual(typeof mod.parsePrintPage, 'function');
  assert.strictEqual(parse(page(row('<th>Code:</th><td><span>T1</span></td>')), CODE).code, 'T1');
});

test('next cell in the next row does not count', () => {
  assert.strictEqual(typeof mod.parsePrintPage, 'function');
  assert.deepStrictEqual(parse(page('<table><tr><td>Code:</td></tr><tr><td><span>NOPE</span></td></tr></table>'), CODE), fail('no-code'));
});

test('next block that is a div does not count', () => {
  assert.strictEqual(typeof mod.parsePrintPage, 'function');
  assert.deepStrictEqual(parse(page('<table><tr><td>Code:</td></tr></table><div><span>NOPE</span></div>'), CODE), fail('no-code'));
  assert.deepStrictEqual(parse(page('<table><tr><td>Code:</td><div><span>NOPE</span></div></tr></table>'), CODE), fail('no-code'));
});

test('label cell with empty rest and no next cell', () => {
  assert.strictEqual(typeof mod.parsePrintPage, 'function');
  assert.deepStrictEqual(parse(page(row('<td>Code:</td>')), CODE), fail('no-code'));
});

test('label cell with non-empty rest and no span does not use next cell', () => {
  assert.strictEqual(typeof mod.parsePrintPage, 'function');
  assert.deepStrictEqual(parse(page(row('<td>Code: 55</td><td><span>NOPE</span></td>')), CODE), fail('no-code'));
});

test('rule 1 wins over rule 2', () => {
  assert.strictEqual(typeof mod.parsePrintPage, 'function');
  assert.strictEqual(parse(page(row('<td>Code: <span>OWN</span></td><td><span>NEXT</span></td>')), CODE).code, 'OWN');
});

test('two rows with different values are ambiguous, same value fine', () => {
  assert.strictEqual(typeof mod.parsePrintPage, 'function');
  const two = (a, b) => '<table><tr><td>Code:</td><td><span>' + a + '</span></td></tr><tr><td>Code:</td><td><span>' + b + '</span></td></tr></table>';
  assert.deepStrictEqual(parse(page(two('A', 'B')), CODE), fail('ambiguous-code'));
  assert.strictEqual(parse(page(two('A', 'A')), CODE).code, 'A');
});

test('hidden code in comment ignored with table layout', () => {
  assert.strictEqual(typeof mod.parsePrintPage, 'function');
  const body = '<!-- <table><tr><td>Code:</td><td><span>HIDDEN</span></td></tr></table> -->' + row('<td>Code:</td><td><span>REAL</span></td>');
  assert.strictEqual(parse(page(body), CODE).code, 'REAL');
});
