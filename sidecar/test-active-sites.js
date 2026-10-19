'use strict';
// Tests for the Costco kill switch in activeSites().
// Task: when SIDECAR_COSTCO_ENABLED is not '1', activeSites must never return 'costco'.
const { test } = require('node:test');
const assert = require('assert');

function loadModule() {
  // Clear any cached require of loginQueue so env vars take effect fresh.
  const key = require.resolve('./src/loginQueue.js');
  delete require.cache[key];
  return require('./src/loginQueue.js');
}

test('activeSites excludes costco when SIDECAR_COSTCO_ENABLED is not set', () => {
  // Remove the env var so the kill switch defaults to DISABLED (costco excluded).
  delete process.env.SIDECAR_COSTCO_ENABLED;
  process.env.TRACKER_URL = 'http://127.0.0.1:9';
  process.env.TRACKER_USER_ID = '1';
  const queue = loadModule();
  const sites = queue.activeSites([]);
  // Current code returns all 4 sites; after fix costco must be absent.
  assert.strictEqual(sites.includes('costco'), false, 'costco must be absent when SIDECAR_COSTCO_ENABLED is unset');
  // Other sites remain unaffected.
  assert.strictEqual(sites.includes('amazon'), true, 'amazon must be present');
  assert.strictEqual(sites.includes('walmart'), true, 'walmart must be present');
  assert.strictEqual(sites.includes('bfmr'), true, 'bfmr must be present');
});

test('activeSites includes costco when SIDECAR_COSTCO_ENABLED equals 1', () => {
  process.env.SIDECAR_COSTCO_ENABLED = '1';
  process.env.TRACKER_URL = 'http://127.0.0.1:9';
  process.env.TRACKER_USER_ID = '1';
  const queue = loadModule();
  const sites = queue.activeSites([]);
  // With the flag set to '1', costco must appear alongside the others.
  assert.strictEqual(sites.includes('costco'), true, 'costco must be present when SIDECAR_COSTCO_ENABLED=1');
  assert.strictEqual(sites.includes('amazon'), true, 'amazon must still be present');
  assert.strictEqual(sites.includes('walmart'), true, 'walmart must still be present');
  assert.strictEqual(sites.includes('bfmr'), true, 'bfmr must still be present');
});
