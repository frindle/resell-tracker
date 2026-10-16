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

const BB = { code: 'Card Number:', pin: 'PIN:' };
const CO = { code: 'Code:', pin: 'PIN:' };

test('pin via span (div layout)', () => {
  assert.strictEqual(typeof mod.parsePrintPage, 'function');
  const r = parse(page('<div>Card Number: <span>111</span></div><div>PIN: <span>2222</span></div>'), BB);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.code, '111');
  assert.strictEqual(r.pin, '2222');
});

test('pin via plain rest text', () => {
  assert.strictEqual(typeof mod.parsePrintPage, 'function');
  const r = parse(page('<div>Card Number: <span>111</span></div><div>PIN: 1234</div>'), BB);
  assert.strictEqual(r.pin, '1234');
  const r2 = parse(page('<table><tr><td>Code:</td><td><span>C</span></td></tr><tr><td>PIN: 98 76</td></tr></table>'), CO);
  assert.strictEqual(r2.pin, '98 76');
});

test('pin via table cells', () => {
  assert.strictEqual(typeof mod.parsePrintPage, 'function');
  const r = parse(page('<table><tr><td>Code:</td><td><span>C</span></td></tr><tr><td>PIN:</td><td><span>77</span></td></tr></table>'), CO);
  assert.strictEqual(r.pin, '77');
});

test('null pin cfg gives null pin', () => {
  assert.strictEqual(typeof mod.parsePrintPage, 'function');
  const r = parse(page('<div>Code: <span>C</span></div><div>PIN: 1234</div>'), CODE);
  assert.strictEqual(r.pin, null);
});

test('no-pin and ambiguous-pin', () => {
  assert.strictEqual(typeof mod.parsePrintPage, 'function');
  assert.deepStrictEqual(parse(page('<div>Card Number: <span>111</span></div>'), BB), fail('no-pin'));
  assert.deepStrictEqual(parse(page('<div>Card Number: <span>111</span></div><div>PIN: 1</div><div>PIN: 2</div>'), BB), fail('ambiguous-pin'));
  assert.strictEqual(parse(page('<div>Card Number: <span>111</span></div><div>PIN: 1</div><div>PIN: <span>1</span></div>'), BB).pin, '1');
});

test('code error wins over pin error', () => {
  assert.strictEqual(typeof mod.parsePrintPage, 'function');
  assert.deepStrictEqual(parse(page('<p>nothing</p>'), BB), fail('no-code'));
  assert.deepStrictEqual(parse(page('<div>Card Number: <span>1</span></div><div>Card Number: <span>2</span></div>'), BB), fail('ambiguous-code'));
});

test('code lookup does not accept rest text', () => {
  assert.strictEqual(typeof mod.parsePrintPage, 'function');
  assert.deepStrictEqual(parse(page('<div>Code: 55</div>'), CODE), fail('no-code'));
});
