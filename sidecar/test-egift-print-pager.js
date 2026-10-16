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

const body = '<p>Code: <span>C1</span></p>';
const pg = (counter, next) => '<html><body>' + counter + (next ? '<input id="btn-wdt-nav-next" type="button">' : '') +
  '<div id="print-content-section"><h2>T</h2>' + body + '</div></body></html>';

test('index total done', () => {
  assert.strictEqual(typeof mod.parsePrintPage, 'function');
  let r = parse(pg('<span id="wdt-page-counter">1 of 3</span>', true), CODE);
  assert.deepStrictEqual([r.ok, r.index, r.total, r.done], [true, 1, 3, false]);
  r = parse(pg('<span id="wdt-page-counter">3 of 3</span>', true), CODE);
  assert.deepStrictEqual([r.ok, r.index, r.total, r.done], [true, 3, 3, true]);
  r = parse(pg('<span id="wdt-page-counter">1 of 3</span>', false), CODE);
  assert.deepStrictEqual([r.ok, r.index, r.total, r.done], [true, 1, 3, true]);
});

test('no-pager cases', () => {
  assert.strictEqual(typeof mod.parsePrintPage, 'function');
  assert.deepStrictEqual(parse(pg('', true), CODE), fail('no-pager'));
  assert.deepStrictEqual(parse(pg('<span id="wdt-page-counter">0 of 3</span>', true), CODE), fail('no-pager'));
  assert.deepStrictEqual(parse(pg('<span id="wdt-page-counter">4 of 3</span>', true), CODE), fail('no-pager'));
  assert.deepStrictEqual(parse(pg('<span id="wdt-page-counter">junk</span>', true), CODE), fail('no-pager'));
  assert.deepStrictEqual(parse(pg('<span id="wdt-page-counter">Page 1 of 3</span>', true), CODE), fail('no-pager'));
});

test('single-quoted id, other tag, attribute order', () => {
  assert.strictEqual(typeof mod.parsePrintPage, 'function');
  let r = parse(pg("<span id='wdt-page-counter'>2 of 4</span>", true), CODE);
  assert.deepStrictEqual([r.index, r.total], [2, 4]);
  r = parse(pg('<div class="c" id="wdt-page-counter" data-x="y">\n 2  of\n4 </div>', true), CODE);
  assert.deepStrictEqual([r.index, r.total], [2, 4]);
});

test('counters elsewhere are ignored', () => {
  assert.strictEqual(typeof mod.parsePrintPage, 'function');
  const r = parse(pg('<p>Page 9 of 99</p><span id="wdt-page-counter">2 of 5</span>', true), CODE);
  assert.deepStrictEqual([r.index, r.total], [2, 5]);
  assert.deepStrictEqual(parse(pg('<p>Page 9 of 99</p>', true), CODE), fail('no-pager'));
});

test('pager checked before code; failure has only ok and reason', () => {
  assert.strictEqual(typeof mod.parsePrintPage, 'function');
  const r = parse('<html><body><p>Code: <span>SECRET</span></p><p>Code: <span>OTHER</span></p></body></html>', CODE);
  assert.deepStrictEqual(r, fail('no-pager'));
});

test('next input id must end with wdt-nav-next', () => {
  assert.strictEqual(typeof mod.parsePrintPage, 'function');
  const h = '<span id="wdt-page-counter">1 of 3</span><input id="wdt-nav-next-x"><div id="print-content-section"><h2>T</h2>' + body + '</div>';
  assert.strictEqual(parse(h, CODE).done, true);
});
