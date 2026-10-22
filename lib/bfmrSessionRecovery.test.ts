/**
 *   node --experimental-strip-types --test lib/bfmrSessionRecovery.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isBfmrAuthError } from './bfmrSessionRecovery.ts';

test('auth errors with BFMR + 401/419 are detected', () => {
  assert.equal(isBfmrAuthError(new Error('BFMR profile 401')), true);
  assert.equal(isBfmrAuthError(new Error('BFMR fetch tracker 401')), true);
  assert.equal(isBfmrAuthError(new Error('Error: BFMR profile 419')), true);
  assert.equal(isBfmrAuthError(new Error('BFMR fetch tracker 419: page expired')), true);
  assert.equal(isBfmrAuthError(new TypeError('BFMR deals 401')), true);
});

test('other statuses and messages without BFMR are rejected', () => {
  assert.equal(isBfmrAuthError(new Error('BFMR fetch tracker 500')), false);
  assert.equal(isBfmrAuthError(new Error('BFMR web login 403: recaptcha')), false);
  assert.equal(isBfmrAuthError(new Error('HTTP 401')), false);
  assert.equal(isBfmrAuthError(new Error('')), false);
});

test('word boundaries: status and BFMR must be whole tokens', () => {
  assert.equal(isBfmrAuthError(new Error('BFMR profile 4010')), false);
  assert.equal(isBfmrAuthError(new Error('BFMR profile 1401')), false);
  assert.equal(isBfmrAuthError(new Error('XBFMR profile 401')), false);
  assert.equal(isBfmrAuthError(new Error('BFMRS profile 401')), false);
  // case-sensitive BFMR, as specified
  assert.equal(isBfmrAuthError(new Error('bfmr profile 401')), false);
});

test('BFMR and the status must be on the same line', () => {
  assert.equal(isBfmrAuthError(new Error('BFMR profile\n401')), false);
  assert.equal(isBfmrAuthError(new Error('upstream failed\nBFMR profile 401')), true);
});

test('non-Error values: strings use String(e), others never match', () => {
  assert.equal(isBfmrAuthError(null), false);
  assert.equal(isBfmrAuthError(undefined), false);
  assert.equal(isBfmrAuthError(42), false);
  assert.equal(isBfmrAuthError(401), false);
  assert.equal(isBfmrAuthError('BFMR profile 401'), true);
  assert.equal(isBfmrAuthError('BFMR profile 500'), false);
  // A plain object is not an Error: String(e) is "[object Object]".
  assert.equal(isBfmrAuthError({ message: 'BFMR profile 401' }), false);
  assert.equal(isBfmrAuthError(Object.create(null)), false);
});
