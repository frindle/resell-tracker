// Adversarial fixture for: egiftPrint (parsePrintPage)
// ALL HTML is SYNTHETIC from the DOM map; codes are fakes (TESTCODE-xxxx). No real portal, no real codes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parsePrintPage } = require('./sidecar/src/costcoEgiftPrint.js') as { parsePrintPage: (html: unknown) => any };

const pager = (n: number, m: number) =>
  `<div class="wdt-nav"><span id="wdt-page-counter">${n} of ${m}</span><input id="j_idt9:wdt-nav-next" type="button" value="Next"></div>`;
// email-style nested-table template, label cell + value-in-span in the NEXT cell
const body = (inner: string) =>
  `<div id="print-content-section"><table id="body-canvas"><tr><td><table id="edge-wrapper"><tr><td><table id="content-wrapper">${inner}</table></td></tr></table></td></tr></table></div>`;
const row = (label: string, value: string) => `<tr><td>${label}</td><td><span>${value}</span></td></tr>`;
const page = (n: number, m: number, inner: string) => `<html><body>${pager(n, m)}${body(inner)}</body></html>`;

test('happy path: pager N of M and the code from the cell after the Code: label', () => {
  const r = parsePrintPage(page(3, 12, row('Value:', '$25.00') + row('Code:', 'TESTCODE-0001')));
  assert.deepEqual(r, { ok: true, index: 3, total: 12, code: 'TESTCODE-0001' });
});

test('label matching is exact: Promo Code / Barcode / PIN rows never supply the code', () => {
  const inner = row('Promo Code:', 'PROMO-9999') + row('Barcode:', 'BARCODE-123') + row('PIN:', 'PIN-4444') + row('Code:', 'TESTCODE-0002');
  assert.equal(parsePrintPage(page(1, 2, inner)).code, 'TESTCODE-0002');
  const none = parsePrintPage(page(1, 2, row('Promo Code:', 'PROMO-9999') + row('Barcode:', 'BARCODE-123')));
  assert.deepEqual(none, { ok: false, reason: 'no-code' });
});

test('the value is the SPAN text: entities decoded, whitespace trimmed and collapsed; non-span text ignored', () => {
  const inner = '<tr><td>Code:</td><td>ignored <b>x</b> <span>\n  TEST&amp;CODE   0003 </span></td></tr>';
  assert.equal(parsePrintPage(page(2, 2, inner)).code, 'TEST&CODE 0003');
  assert.deepEqual(parsePrintPage(page(2, 2, '<tr><td>Code:</td><td>TESTCODE-NOSPAN</td></tr>')), { ok: false, reason: 'no-code' });
});

test('same-cell layout: <td>Code: <span>value</span></td>', () => {
  assert.equal(parsePrintPage(page(1, 1, '<tr><td>Code: <span>TESTCODE-0004</span></td></tr>')).code, 'TESTCODE-0004');
});

test('the value must be in the NEXT cell of the SAME row, not the first cell of the next row', () => {
  const inner = '<tr><td>Code:</td></tr><tr><td><span>TESTCODE-ROWLEAK</span></td></tr>';
  assert.deepEqual(parsePrintPage(page(1, 1, inner)), { ok: false, reason: 'no-code' });
});

test('markup in comments and scripts is ignored (decoy codes)', () => {
  const html = '<!-- <table><tr><td>Code:</td><td><span>TESTCODE-GHOST</span></td></tr></table> -->' +
    '<script>var t = "<td>Code:</td><td><span>TESTCODE-GHOST2</span></td>";</script>' +
    page(1, 1, row('Code:', 'TESTCODE-0005'));
  assert.equal(parsePrintPage(html).code, 'TESTCODE-0005');
});

test('the same code repeated (mobile + desktop copies) is fine; two DIFFERENT codes are ambiguous and leak nothing', () => {
  assert.equal(parsePrintPage(page(1, 1, row('Code:', 'TESTCODE-0006') + row('Code:', 'TESTCODE-0006'))).code, 'TESTCODE-0006');
  const amb = parsePrintPage(page(1, 1, row('Code:', 'TESTCODE-AAAA') + row('Code:', 'TESTCODE-BBBB')));
  assert.deepEqual(amb, { ok: false, reason: 'ambiguous-code' });
  assert.ok(!JSON.stringify(amb).includes('TESTCODE'));
});

test('pager comes from #wdt-page-counter only; decoy counters elsewhere are ignored', () => {
  const html = '<p>Page 9 of 99</p>' + pager(5, 12) + '<span class="other">1 of 2</span>' + body(row('Code:', 'TESTCODE-0007'));
  assert.deepEqual(parsePrintPage(html), { ok: true, index: 5, total: 12, code: 'TESTCODE-0007' });
});

test('bad pager -> no-pager: missing, malformed, zero, or N greater than M', () => {
  const b = body(row('Code:', 'TESTCODE-0008'));
  for (const counter of ['', '<span id="wdt-page-counter">soon</span>', '<span id="wdt-page-counter">0 of 12</span>', '<span id="wdt-page-counter">13 of 12</span>']) {
    assert.deepEqual(parsePrintPage(counter + b), { ok: false, reason: 'no-pager' });
  }
});

test('failures never throw and never echo the page; non-string input is invalid-input', () => {
  for (const bad of [null, undefined, 7, {}, []]) assert.deepEqual(parsePrintPage(bad), { ok: false, reason: 'invalid-input' });
  const r = parsePrintPage(pager(1, 1) + '<td>Code:</td><td><span></span></td><p>SECRET-' + 'MARKER</p>');
  assert.deepEqual(r, { ok: false, reason: 'no-code' });
  assert.ok(!JSON.stringify(r).includes('SECRET'));
});
