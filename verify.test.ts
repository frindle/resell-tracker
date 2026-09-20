// Adversarial repo-style test for: rt-costco-always-sites-s2-costco-to-always-sites   (node --test / tsx --test)
//
// The target is a CommonJS sidecar module; import it the way the repo does.
// lib.js throws at IMPORT time without TRACKER_URL/TRACKER_USER_ID, so set
// dummies BEFORE requiring (verify.sh also exports them).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.TRACKER_URL = process.env.TRACKER_URL || 'http://localhost:3000';
process.env.TRACKER_USER_ID = process.env.TRACKER_USER_ID || '1';
const { activeSites, isEnabled } = require('./sidecar/src/loginQueue.js');

test('activeSites is exported and callable', () => {
  assert.equal(typeof activeSites, 'function');
});

// THE CORE DEFECT: costco must be returned even when statuses is empty / has
// no costco_sidecar_enabled key. A fix that leaves costco opt-in fails here.
test('activeSites({}) includes costco alongside amazon and walmart', () => {
  const sites = activeSites({});
  assert.ok(sites.includes('costco'), `expected costco in ${JSON.stringify(sites)}`);
  assert.ok(sites.includes('amazon'));
  assert.ok(sites.includes('walmart'));
  assert.equal(new Set(sites).size, sites.length, 'no duplicate sites');
});

// OVER-TRIGGER GUARD: the change must not drop or reorder the existing
// always-on sites. costco is appended after them (ALWAYS_SITES order).
test('activeSites preserves amazon/walmart first and appends costco', () => {
  const sites = activeSites({});
  assert.deepEqual(sites, ['amazon', 'walmart', 'costco']);
});

// Even an EXPLICITLY falsy opt-in flag must not hide costco anymore -- it is
// no longer gated on costco_sidecar_enabled at all. A plausible wrong fix that
// only special-cases the missing key (but still honours a false value) fails.
test('activeSites ignores a disabled costco_sidecar_enabled flag', () => {
  const sites = activeSites({ costco_sidecar_enabled: 'false' });
  assert.ok(sites.includes('costco'), `expected costco in ${JSON.stringify(sites)}`);
});

// Unrelated status keys must not perturb the result.
test('activeSites is stable under unrelated statuses', () => {
  const sites = activeSites({ amazon_session_status: 'expired', walmart_session_status: 'ok' });
  assert.deepEqual(sites, ['amazon', 'walmart', 'costco']);
});

// isEnabled must still be exported and keep its truthy-spelling contract.
test('isEnabled accepts the usual truthy spellings (case/space-insensitive)', () => {
  for (const v of ['1', 'true', 'yes', 'on', ' TRUE ', 'On']) {
    assert.equal(isEnabled(v), true, `expected isEnabled(${JSON.stringify(v)}) === true`);
  }
});

// ...and rejects falsy / degenerate inputs without throwing.
test('isEnabled is false for falsy and degenerate values (no throw)', () => {
  for (const v of [undefined, null, '', '0', 'false', 'no', 'off', 'maybe']) {
    assert.equal(isEnabled(v), false, `expected isEnabled(${JSON.stringify(v)}) === false`);
  }
});
