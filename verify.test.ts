// Adversarial fixture for: egiftPrint (parsePrintPage, parameterized per site)
// ALL HTML is SYNTHETIC from the DOM maps (Costco: label cell + value in span; Best Buy: div "Card Number:"
// with a span value and div "PIN:" with plain text). Codes are fakes (0000-style). No real portal, no real codes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parsePrintPage } = require('./sidecar/src/costcoEgiftPrint.js') as { parsePrintPage: (html: unknown, cfg?: unknown) => any };

const COSTCO = { code: 'Code:', pin: null };
const BESTBUY = { code: 'Card Number:', pin: 'PIN:' };

const pager = (n: number, m: number, next = true) =>
  `<div class="wdt-nav"><span id="wdt-page-counter">${n} of ${m}</span>${n > 1 ? '<input id="j_idt9:wdt-nav-prev" type="submit" value="Prev">' : ''}` +
  `${next ? '<input id="j_idt9:wdt-nav-next" type="submit" value="Next">' : ''}</div>`;
// email-style nested-table template (Costco): label cell + value-in-span in the NEXT cell
const tbody = (inner: string) =>
  `<div id="print-content-section"><table id="body-canvas"><tr><td><table id="edge-wrapper"><tr><td><table id="content-wrapper">${inner}</table></td></tr></table></td></tr></table></div>`;
const row = (label: string, value: string) => `<tr><td>${label}</td><td><span>${value}</span></td></tr>`;
const page = (n: number, m: number, inner: string, next = true) => `<html><body>${pager(n, m, next)}${tbody(inner)}</body></html>`;
// Best Buy: div blocks
const bb = (num: string, pin: string, n = 1, m = 3, next = true) =>
  `<html><body>${pager(n, m, next)}<div id="print-content-section"><div id="body-canvas"><div id="edge-wrapper"><div id="content-wrapper">` +
  `<h2>StubHub $100</h2><div>Card Number: <span>${num}</span></div><div>PIN: ${pin}</div>` +
  `<p>Redemption Instructions</p><p>Enter your PIN: at checkout. PINs are 11 characters.</p></div></div></div></div></body></html>`;

test('costco happy path: index/total, code from the cell after Code:, pin null, not done mid-way', () => {
  const r = parsePrintPage(page(3, 12, row('Value:', '$25.00') + row('Code:', 'TESTCODE-0001')), COSTCO);
  assert.deepEqual(r, { ok: true, index: 3, total: 12, done: false, code: 'TESTCODE-0001', pin: null, title: '' });
});

test('bestbuy happy path: Card Number from the span, PIN from plain text, decoy instruction text ignored', () => {
  const r = parsePrintPage(bb('00000000000000000001', '00000000001'), BESTBUY);
  assert.deepEqual(r, { ok: true, index: 1, total: 3, done: false, code: '00000000000000000001', pin: '00000000001', title: 'StubHub $100' });
});

test('done: true on the last card (counter == total) even when a Next input is still present, and when Next is absent', () => {
  assert.equal(parsePrintPage(bb('00000000000000000003', '00000000003', 3, 3, true), BESTBUY).done, true);
  assert.equal(parsePrintPage(bb('00000000000000000003', '00000000003', 3, 3, false), BESTBUY).done, true);
});

test('done: true as the BACKUP stop when the Next input is absent but the counter says more remain', () => {
  assert.equal(parsePrintPage(bb('00000000000000000002', '00000000002', 2, 3, false), BESTBUY).done, true);
  assert.equal(parsePrintPage(bb('00000000000000000002', '00000000002', 2, 3, true), BESTBUY).done, false);
});

test('a Best Buy page without a PIN fails no-pin; a Costco config never asks for one', () => {
  const noPin = '<div>Card Number: <span>00000000000000000009</span></div>';
  assert.deepEqual(parsePrintPage(pager(1, 1) + noPin, BESTBUY), { ok: false, reason: 'no-pin' });
  assert.deepEqual(parsePrintPage(pager(1, 1) + noPin, { code: 'Card Number:', pin: null }), { ok: true, index: 1, total: 1, done: true, code: '00000000000000000009', pin: null, title: '' });
  assert.deepEqual(parsePrintPage(pager(1, 1) + '<div>PIN: 12345678901</div>', BESTBUY), { ok: false, reason: 'no-code' });
});

test('PIN is the plain text AFTER the label in its own block, entities decoded, whitespace collapsed; two different PINs are ambiguous-pin', () => {
  assert.equal(parsePrintPage(bb('00000000000000000004', ' 0000&amp;  0004 '), BESTBUY).pin, '0000& 0004');
  const two = pager(1, 1) + '<div>Card Number: <span>00000000000000000005</span></div><div>PIN: 11111111111</div><div>PIN: 22222222222</div>';
  const r = parsePrintPage(two, BESTBUY);
  assert.deepEqual(r, { ok: false, reason: 'ambiguous-pin' });
});

test('label matching is exact: Promo Code / Barcode / PIN rows never supply the Costco code', () => {
  const inner = row('Promo Code:', 'PROMO-9999') + row('Barcode:', 'BARCODE-123') + row('PIN:', 'PIN-4444') + row('Code:', 'TESTCODE-0002');
  assert.equal(parsePrintPage(page(1, 2, inner), COSTCO).code, 'TESTCODE-0002');
  assert.deepEqual(parsePrintPage(page(1, 2, row('Promo Code:', 'PROMO-9999') + row('Barcode:', 'BARCODE-123')), COSTCO), { ok: false, reason: 'no-code' });
});

test('costco value is the SPAN text (entities decoded, whitespace collapsed); a next cell with plain text is no value', () => {
  assert.equal(parsePrintPage(page(2, 2, '<tr><td>Code:</td><td>ignored <b>x</b> <span>\n  TEST&amp;CODE   0003 </span></td></tr>'), COSTCO).code, 'TEST&CODE 0003');
  assert.deepEqual(parsePrintPage(page(2, 2, '<tr><td>Code:</td><td>TESTCODE-NOSPAN</td></tr>'), COSTCO), { ok: false, reason: 'no-code' });
});

test('same-cell layout, and the value must be in the NEXT cell of the SAME row (not the next row)', () => {
  assert.equal(parsePrintPage(page(1, 1, '<tr><td>Code: <span>TESTCODE-0004</span></td></tr>'), COSTCO).code, 'TESTCODE-0004');
  assert.deepEqual(parsePrintPage(page(1, 1, '<tr><td>Code:</td></tr><tr><td><span>TESTCODE-ROWLEAK</span></td></tr>'), COSTCO), { ok: false, reason: 'no-code' });
});

test('markup in comments and scripts is ignored (decoy codes)', () => {
  const html = '<!-- <table><tr><td>Code:</td><td><span>TESTCODE-GHOST</span></td></tr></table> -->' +
    '<script>var t = "<td>Code:</td><td><span>TESTCODE-GHOST2</span></td>";</script>' + page(1, 1, row('Code:', 'TESTCODE-0005'));
  assert.equal(parsePrintPage(html, COSTCO).code, 'TESTCODE-0005');
});

test('the same code repeated is fine; two DIFFERENT codes are ambiguous-code and leak nothing', () => {
  assert.equal(parsePrintPage(page(1, 1, row('Code:', 'TESTCODE-0006') + row('Code:', 'TESTCODE-0006')), COSTCO).code, 'TESTCODE-0006');
  const amb = parsePrintPage(page(1, 1, row('Code:', 'TESTCODE-AAAA') + row('Code:', 'TESTCODE-BBBB')), COSTCO);
  assert.deepEqual(amb, { ok: false, reason: 'ambiguous-code' });
  assert.ok(!JSON.stringify(amb).includes('TESTCODE'));
});

test('pager comes from #wdt-page-counter only; decoy counters elsewhere are ignored', () => {
  const html = '<p>Page 9 of 99</p>' + pager(5, 12) + '<span class="other">1 of 2</span>' + tbody(row('Code:', 'TESTCODE-0007'));
  assert.deepEqual(parsePrintPage(html, COSTCO), { ok: true, index: 5, total: 12, done: false, code: 'TESTCODE-0007', pin: null, title: '' });
});

test('bad pager -> no-pager: missing, malformed, zero, or N greater than M', () => {
  const b = tbody(row('Code:', 'TESTCODE-0008'));
  for (const counter of ['', '<span id="wdt-page-counter">soon</span>', '<span id="wdt-page-counter">0 of 12</span>', '<span id="wdt-page-counter">13 of 12</span>']) {
    assert.deepEqual(parsePrintPage(counter + b, COSTCO), { ok: false, reason: 'no-pager' });
  }
});

test('invalid input never throws; failures never echo the page or any secret', () => {
  for (const bad of [null, undefined, 7, {}, []]) assert.deepEqual(parsePrintPage(bad, COSTCO), { ok: false, reason: 'invalid-input' });
  for (const cfg of [undefined, null, {}, { code: 3 }]) assert.deepEqual(parsePrintPage(page(1, 1, row('Code:', 'X')), cfg), { ok: false, reason: 'invalid-input' });
  const r = parsePrintPage(bb('00000000000000000007', '') + '<p>SECRET-' + 'MARKER</p>', BESTBUY);
  assert.deepEqual(r, { ok: false, reason: 'no-pin' });
  assert.ok(!JSON.stringify(r).includes('SECRET') && !JSON.stringify(r).includes('0000000000000000000'));
});

const UBER_H2 = '<h2 style="font-size:16px; line-height:20px; margin:10px 0 10px 0;">Uber $50 eGift Cards</h2>';
const withTitle = (h2: string, inner: string) =>
  `<html><body>${pager(1, 1)}<div id="print-content-section"><table id="body-canvas"><tr><td>${h2}<table>${inner}</table></td></tr></table></div></body></html>`;

test('title: the first h2 inside #print-content-section, located structurally (inline style is a distractor)', () => {
  const r = parsePrintPage(withTitle(UBER_H2, row('Code:', 'TESTCODE-0020')), COSTCO);
  assert.deepEqual(r, { ok: true, index: 1, total: 1, done: true, code: 'TESTCODE-0020', pin: null, title: 'Uber $50 eGift Cards' });
  assert.equal(parsePrintPage(withTitle('<h2>Uber $50 eGift Cards</h2>', row('Code:', 'TESTCODE-0020')), COSTCO).title, 'Uber $50 eGift Cards');
});

test('title: an h2 OUTSIDE #print-content-section is ignored; only the first inside counts; entities and tags normalized', () => {
  const html = `<html><body><h2>Site Header Decoy</h2>${pager(1, 1)}<div id="print-content-section"><h2 class="x">Dev &amp; <b>Co</b>  $5 eGift Card</h2><h2>Second</h2><table>${row('Code:', 'TESTCODE-0021')}</table></div><h2>Footer</h2></body></html>`;
  assert.equal(parsePrintPage(html, COSTCO).title, 'Dev & Co $5 eGift Card');
  assert.equal(parsePrintPage(`<html><body><h2>Only Outside</h2>${pager(1, 1)}${tbody(row('Code:', 'TESTCODE-0022'))}</body></html>`, COSTCO).title, '');
});

test('title (Best Buy real shape): inline-style h2 with leading/trailing whitespace and newlines inside the tag', () => {
  const h2 = '<h2 style="font-size:16px; line-height:20px; margin-top:0px; margin-bottom:10px; margin-left:10px; margin-right:10px;">\n      StubHub $100\n   </h2>';
  const html = `<html><body>${pager(1, 3)}<div id="print-content-section"><div id="body-canvas"><div id="content-wrapper">${h2}<div>Card Number: <span>00000000000000000010</span></div><div>PIN: 00000000010</div></div></div></div></body></html>`;
  assert.deepEqual(parsePrintPage(html, BESTBUY), { ok: true, index: 1, total: 3, done: false, code: '00000000000000000010', pin: '00000000010', title: 'StubHub $100' });
});
