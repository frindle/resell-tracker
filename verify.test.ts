// Adversarial repo-style test for: amazon-iris-payment-fix   (node --test)
// Drives the pure exported helper extractIrisLastDigits(rawText). The Puppeteer
// page.frames() wiring that FEEDS it the frame text is NOT unit-testable (frame
// discovery needs a live Amazon page) and is validated on the next live sync +
// pinned structurally by the Must-contain list; this file proves the PARSE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractIrisLastDigits } from './sidecar/src/amazon.js';

// Real order-917 iris __NEXT_DATA__ shape: the card last-4 lives at
// paymentMethodNumber.lastDigits, surrounded by decoy 4-digit runs (expiry
// year 2030, an order id) that a naive /\d{4}/ grab would return instead.
const IRIS_NEXT_DATA = JSON.stringify({
  props: { pageProps: { paymentInstrument: {
    paymentMethodType: 'Visa',
    paymentMethodNumber: { prefix: '••••', lastDigits: '3069' },
    expirationMonth: '11', expirationYear: '2030',
    orderId: '112-4455667-8899001',
  } } },
});

test('structured: pulls lastDigits from paymentMethodNumber, not a decoy', () => {
  assert.equal(extractIrisLastDigits(IRIS_NEXT_DATA), '3069');
});

test('visible innerText fallback: bullet-masked tail', () => {
  assert.equal(extractIrisLastDigits('Visa •••• 3069\nExp 11/2030'), '3069');
});

test('asterisk-masked fallback', () => {
  assert.equal(extractIrisLastDigits('Card ending **** 4821'), '4821');
});

// OVER-TRIGGER GUARD: no card number anywhere -> null, never a decoy 4-digit.
test('over-trigger guard: expiry/order digits but no card number -> null', () => {
  const noCard = JSON.stringify({ props: { pageProps: {
    expirationYear: '2030', orderId: '112-4455667-8899001', amount: '1299',
  } } });
  assert.equal(extractIrisLastDigits(noCard), null);
});

// WRONG-FIX CATCHER: decoy 4-digit runs appear BEFORE the real lastDigits.
// A fix that returns the first 4-digit run yields '2030'/'1124'; the correct
// fix keys on paymentMethodNumber.lastDigits.
test('wrong-fix catcher: lastDigits after decoy 4-digit runs', () => {
  const blob = '{"year":"2030","code":"1124","paymentMethodNumber":{"prefix":"\\u2022\\u2022\\u2022\\u2022","lastDigits":"7788"}}';
  assert.equal(extractIrisLastDigits(blob), '7788');
});

test('degenerate: null / empty / non-string -> null, no throw', () => {
  assert.equal(extractIrisLastDigits(null as any), null);
  assert.equal(extractIrisLastDigits(''), null);
  assert.equal(extractIrisLastDigits(undefined as any), null);
  assert.equal(extractIrisLastDigits(12345 as any), null);
});

// Malformed/truncated JSON (structured parse fails) but a masked tail is in the
// visible text -> fallback still recovers it.
test('malformed json with visible masked tail -> fallback', () => {
  assert.equal(extractIrisLastDigits('{"paymentMethodNumber":{"lastDig ...TRUNCATED •••• 5150'), '5150');
});
