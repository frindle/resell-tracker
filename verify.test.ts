// Model-drafted; NOT yet read by a human.
const DRAFT_UNCONFIRMED = true;

// Adversarial repo-style test for: rt-costco-always-sites (node --test / tsx --test)
//
// The target sidecar/src/loginQueue.js is CommonJS and pulls in ./lib (tracker
// HTTP + local session files) and ./loginFlow (browser flow). To make
// sitesNeedingLogin() fully deterministic we seed the CJS require cache with
// stubs for BOTH deps BEFORE importing loginQueue, so no tracker call, no
// session file, and no browser is ever touched. The stubs are driven by
// module-level state that each case reconfigures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire, Module } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const anchor = path.join(here, 'sidecar', 'src', 'loginQueue.js');
const req = createRequire(anchor);

function stub(specifier: string, exportsObj: Record<string, unknown>) {
  const resolved = req.resolve(specifier); // same resolution loginQueue's require() uses
  const m = new Module(resolved) as any;
  m.exports = exportsObj;
  m.loaded = true;
  (Module as any)._cache[resolved] = m;
}

// --- stub state, reconfigured per case -------------------------------------
const sessions = new Set<string>();          // hasSession(site) -> membership
let settings: Record<string, unknown> | null = {}; // getSettings() return; null => throws

stub('./lib', {
  hasSession: (site: string) => sessions.has(site),
  getSettings: async () => {
    if (settings === null) throw new Error('tracker unreachable');
    return settings;
  },
  launchBrowser: async () => {
    throw new Error('launchBrowser must not run during sitesNeedingLogin()');
  },
});

stub('./loginFlow', {
  SITE_CONFIG: { amazon: {}, walmart: {}, costco: {} },
  waitForLogin: async () => false,
});

// Load the target through the same CJS require whose cache we seeded above --
// synchronous, so no top-level await is needed (tsx runs this file as CJS).
const loginQueue = req('./loginQueue.js') as any;
const sitesNeedingLogin = loginQueue.sitesNeedingLogin;

test('costco is queued even when costco_sidecar_enabled is unset', async () => {
  sessions.clear();
  settings = {}; // no opt-in flag at all -- the legacy behaviour dropped costco here
  const needing = await sitesNeedingLogin();
  assert.deepEqual(needing, ['amazon', 'walmart', 'costco']);
});

test('legacy opt-in flag set does not duplicate costco in the queue', async () => {
  sessions.clear();
  settings = { costco_sidecar_enabled: 'true' }; // a wrong fix that keeps costco in BOTH lists queues it twice
  const needing = await sitesNeedingLogin();
  assert.deepEqual(needing, ['amazon', 'walmart', 'costco']);
});

test('sites with a valid session and non-expired status are not queued', async () => {
  sessions.add('amazon');
  sessions.add('walmart');
  sessions.add('costco');
  settings = {
    amazon_session_status: 'ok',
    walmart_session_status: 'active',
    costco_session_status: 'valid',
  };
  const needing = await sitesNeedingLogin();
  assert.deepEqual(needing, []);
});

test('expired status queues the site even when a session file exists', async () => {
  sessions.add('amazon');
  sessions.add('walmart');
  sessions.add('costco');
  settings = {
    amazon_session_status: 'expired',
    walmart_session_status: 'ok',
    costco_session_status: 'expired',
  };
  const needing = await sitesNeedingLogin();
  assert.deepEqual(needing, ['amazon', 'costco']);
});

test('settings fetch failure falls back to the local session-file check only', async () => {
  sessions.clear();
  settings = null; // getSettings() throws -- must not crash, and costco still counts
  const needing = await sitesNeedingLogin();
  assert.deepEqual(needing, ['amazon', 'walmart', 'costco']);
});
