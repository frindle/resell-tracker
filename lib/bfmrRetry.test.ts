/**
 *   node --experimental-strip-types --test lib/bfmrRetry.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { bfmrRetryDelayMs, bfmrErrorText } from './bfmr.ts';

test('Retry-After seconds win, capped at 30s', () => {
  assert.equal(bfmrRetryDelayMs(0, '3'), 3000);
  assert.equal(bfmrRetryDelayMs(0, '999'), 30000);
});
test('no header: exponential backoff, capped', () => {
  assert.equal(bfmrRetryDelayMs(0, null), 1500);
  assert.equal(bfmrRetryDelayMs(2, null), 6000);
  assert.equal(bfmrRetryDelayMs(10, null), 20000);
});
test('error text strips an HTML 429 page to a short plain message', () => {
  const html = '<!DOCTYPE html><html><head><style>body{margin:0}</style><title>Too Many Requests</title></head><body><div>429 Too Many Requests</div></body></html>';
  const t = bfmrErrorText(429, html);
  assert.ok(t.startsWith('BFMR 429:'));
  assert.ok(!t.includes('<') && !t.includes('margin'));
  assert.ok(t.length < 260);
});
