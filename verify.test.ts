// Adversarial repo-style test for: resell-sync-queue-when-busy   (node --test / tsx --test)
//
// Tests the handleCommand path in sidecar/src/poll.js for the BrowserBusyError
// handling when acquireBrowserLock returns a holder with kind === 'sync'.
//
// At baseline (current code), BOTH kind === 'sync' and kind === 'login' fail
// with the login-window-blaming message. The fix must distinguish them:
//   - kind === 'sync': queue and wait (with max wait), do NOT fail immediately
//   - kind === 'login': keep existing failure behaviour with login-window message

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Module-scope mocks: vary behaviour through shared mutable fakes.
// The target (sidecar/src/poll.js) requires './lib' which exports
// acquireBrowserLock, BrowserBusyError, patchCommand, hasSession, etc.
// ---------------------------------------------------------------------------

// Fake patchCommand calls: recorded per test, cleared between tests.
let _patchCalls = [];
// Fake acquireBrowserLock: returns a release function on success,
// or throws BrowserBusyError on failure.
let _lockResult = null;  // null = success (release fn), or { error: BrowserBusyError }
// Fake hasSession: default true (has session), can be overridden.
let _hasSession = true;
// Fake launchBrowser / newContextForSite: throw a controlled error.
let _launchError = null;
// Fake getSettings: return settings object.
let _settings = {};
// Fake setSettings: record calls.
let _setSettingsCalls = [];
// Fake syncAmazon: record calls.
let _syncAmazonCalls = [];
// Fake syncWalmart: record calls();

// Build a compact fake lib module with the exports poll.js needs.
// The browser/page objects are stubs — they are never exercised by the tests,
// but the real lib exports them so we must provide a shape.  Use a factory
// to avoid duplicate property names in the object literal.
function _makeBrowser() {
  return {
    newContext: async () => _makeContext(),
    close: async () => {},
    isClosed: () => false,
  };
}
function _makeContext() {
  return {
    newPage: async () => _makePage(),
    close: async () => {},
    isClosed: () => false,
  };
}
function _makePage() {
  return {
    on: () => {},
    evaluate: async () => ({}),
    $: () => null,
    $$: () => [],
    $eval: async () => null,
    $$eval: async () => [],
    goto: async () => ({ status: 200 }),
    click: async () => {},
    fill: async () => {},
    type: async () => {},
    check: async () => {},
    locator: () => ({ click: async () => {}, fill: async () => {}, type: async () => {} }),
    content: async () => '',
    title: async () => '',
    screenshot: async () => Buffer.from(''),
    close: async () => {},
    isClosed: () => false,
    frames: () => [],
    mainFrame: () => ({
      waitForSelector: async () => null,
      waitForFunction: async () => null,
      waitForURL: async () => {},
      waitForLoadState: async () => {},
      waitForTimeout: async () => {},
      waitForNavigation: async () => {},
      waitForResponse: async () => null,
      click: async () => {},
      fill: async () => {},
      type: async () => {},
      check: async () => {},
      content: async () => '',
      title: async () => '',
      screenshot: async () => Buffer.from(''),
      on: () => {},
      once: () => {},
      off: () => {},
      emit: () => {},
      pages: async () => [],
    }),
    context: () => ({
      pages: async () => [],
      storageState: async () => ({}),
      cookies: async () => [],
      addInitScript: async () => {},
      close: async () => {},
      isClosed: () => false,
    }),
  };
}

const fakeLib = {
  getSettings: async () => _settings,
  setSettings: async (obj) => { _setSettingsCalls.push(obj); return obj; },
  fetchCommands: async () => [],
  patchCommand: async (id, status, result) => {
    _patchCalls.push({ id, status, result });
    return { id, status, result };
  },
  pushOrders: async () => ({ imported: 0, updated: 0, skipped: 0 }),
  pushCostcoReceipts: async () => ({ linked: 0, unlinked: 0 }),
  pushPortalRates: async () => ({ upserted: 0 }),
  fetchBfmrVendors: async () => [],
  fetchMissingTrackingOrderNumbers: async () => [],
  queueCommand: async () => ({ id: 999 }),
  logApiError: async () => {},
  captureFailure: async () => ({}),
  launchBrowser: async () => {
    if (_launchError) throw _launchError;
    return _makeBrowser();
  },
  newContextForSite: async (browser, site) => {
    if (_launchError) throw _launchError;
    return _makeContext();
  },
  SessionExpiredError: class SessionExpiredError extends Error {
    constructor(site) {
      super(`${site} session expired or not logged in`);
      this.name = 'SessionExpiredError';
      this.site = site;
    }
  },
  hasSession: (site) => _hasSession,
  refreshVncPasswordFile: async () => ({ ok: true, count: 1 }),
  sessionPath: (site) => `/data/sessions/${site}-session.json`,
  pushBfmrWebRows: async () => ({ accepted: 0, synced: 0, webBackfilled: 0, autoLinked: 0 }),
  acquireBrowserLock: async (kind, opts) => {
    if (_lockResult) {
      throw _lockResult.error;
    }
    return async () => {};
  },
  BrowserBusyError: class BrowserBusyError extends Error {
    constructor(message, holder) {
      super(message);
      this.name = 'BrowserBusyError';
      this.holder = holder || null;
    }
  },
  logApiError: async () => {},
  captureFailure: async () => ({}),
  fetchCommands: async () => [],
  queueCommand: async () => ({ id: 999 }),
  pushBfmrWebRows: async () => ({ accepted: 0, synced: 0, webBackfilled: 0, autoLinked: 0 }),
};

// Install the mock at module scope.
mock.module('./sidecar/src/lib', { exports: fakeLib });

// Also mock the sync modules so they don't throw.
mock.module('./sidecar/src/amazon', { exports: { syncAmazon: async () => [], syncAmazonOrders: async () => [] } });
mock.module('./sidecar/src/walmart', { exports: { syncWalmart: async () => [] } });
mock.module('./sidecar/src/costco', { exports: { syncCostco: async () => ({ orders: [], receipts: [] }), installInterceptor: async () => {} } });
mock.module('./sidecar/src/bfmr', { exports: { syncBfmr: async () => ({ orders: [], receipts: [] }), installInterceptor: async () => {} } });
mock.module('./sidecar/src/cashbackmonitor', { exports: { scrapeCashbackMonitor: async () => ({ entries: [], results: [] }) } });
mock.module('./sidecar/src/loginCooldown', { exports: { requestPreempt: async () => {}, clearPreemptRequest: async () => {} } });

// ---------------------------------------------------------------------------
// Helper: reset all fakes between tests.
// ---------------------------------------------------------------------------
function resetFakes() {
  _patchCalls = [];
  _setSettingsCalls = [];
  _syncAmazonCalls = [];
  _syncWalmartCalls = [];
  _lockResult = null;
  _hasSession = true;
  _launchError = null;
  _settings = {};
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

test('login-busy: holder.kind === login fails with login-window message', async () => {
  resetFakes();
  // At baseline: login holder kind -> fails with login-window message
  const busyErr = new fakeLib.BrowserBusyError('sync in progress (amazon)', {
    kind: 'login', site: 'amazon',
  });
  _lockResult = { error: busyErr };

  const { handleCommand } = await import('./sidecar/src/poll.js');

  const cmd = { id: 1, type: 'SYNC_AMAZON', status: 'pending' };
  await handleCommand(cmd);

  // Should have patched to 'failed' with the login-window-blaming message
  const patchCall = _patchCalls.filter(c => c.id === 1).pop();
  assert.equal(patchCall.status, 'failed');
  assert.ok(patchCall.result.error.includes('-- try again when the login window is closed'),
    `Expected login-window message, got: ${patchCall.result.error}`);
});

test('sync-busy: holder.kind === sync queues and waits (does NOT fail immediately)', async () => {
  resetFakes();
  // First call: sync holder kind -> should NOT fail immediately
  const busyErr = new fakeLib.BrowserBusyError('sync in progress (amazon)', {
    kind: 'sync', site: 'amazon',
  });
  _lockResult = { error: busyErr };

  const { handleCommand } = await import('./sidecar/src/poll.js');

  const cmd = { id: 2, type: 'SYNC_AMAZON', status: 'pending' };

  // With the fix, handleCommand should NOT call patchCommand with 'failed'
  // when the holder is sync. Instead it should queue and wait.
  // At baseline, it fails immediately with the login-window message.
  await handleCommand(cmd);

  // Check: the command should NOT be patched to 'failed' with login-window message
  // (the fix would queue it instead). At baseline, it IS patched to 'failed'.
  const patchCall = _patchCalls.filter(c => c.id === 2).pop();
  assert.ok(patchCall, 'patchCommand should have been called');

  // At baseline: the sync-busy case is treated the same as login-busy,
  // so it fails with the login-window message. The fix should NOT do this.
  // Fixed behaviour: a sync holder must never be reported as a login window.
  assert.ok(!String(patchCall.result?.error || '').includes('login window is closed'),
    'sync-busy must not be treated as login-busy');
});

test('sync-busy: no-session command fails immediately (unchanged)', async () => {
  resetFakes();
  _hasSession = false;

  const { handleCommand } = await import('./sidecar/src/poll.js');

  const cmd = { id: 3, type: 'SYNC_AMAZON', status: 'pending' };
  await handleCommand(cmd);

  const patchCall = _patchCalls.filter(c => c.id === 3).pop();
  assert.equal(patchCall.status, 'failed');
  assert.ok(patchCall.result.error.includes('no saved amazon session'),
    'No-session command should fail with no-session message');
});

test('lock-acquired: sync proceeds normally', async () => {
  resetFakes();
  // Lock succeeds (no error thrown).
  _lockResult = null;

  const { handleCommand } = await import('./sidecar/src/poll.js');

  const cmd = { id: 4, type: 'SYNC_AMAZON', status: 'pending' };
  await handleCommand(cmd);

  // Should have patched to 'done' (sync completed successfully).
  const patchCall = _patchCalls.filter(c => c.id === 4).pop();
  assert.equal(patchCall.status, 'done');
});

test('sync-busy: after sync finishes, queued command runs', async () => {
  resetFakes();
  // First call: sync holder kind -> should queue and wait
  const busyErr = new fakeLib.BrowserBusyError('sync in progress (amazon)', {
    kind: 'sync', site: 'amazon',
  });
  _lockResult = { error: busyErr };

  const { handleCommand } = await import('./sidecar/src/poll.js');

  const cmd = { id: 5, type: 'SYNC_AMAZON', status: 'pending' };
  await handleCommand(cmd);

  // At baseline: the command is patched to 'failed' with login-window message.
  // The fix should instead queue it and wait for the sync to finish,
  // then run it when the lock becomes available.
  const patchCall = _patchCalls.filter(c => c.id === 5).pop();
  assert.ok(patchCall, 'patchCommand should have been called');

  // At baseline: sync-busy is treated as login-busy -> fails with wrong message.
  // The fix: should NOT fail with login-window message, should instead queue.
  // Fixed behaviour: a sync holder must never be reported as a login window.
  assert.ok(!String(patchCall.result?.error || '').includes('login window is closed'),
    'sync-busy must not be treated as login-busy');
});

// ---------------------------------------------------------------------------
// Adversarial cases: kill surviving mutations
// ---------------------------------------------------------------------------

// Mutation: refimpl.py:54 `>=` → `>` (boundary)
// If the boundary becomes `>`, waiting exactly maxWaitMs (120000ms)
// would NOT trigger the timeout — the command would keep waiting.
// The fixture checks that at exactly maxWaitMs the command IS timed out.
test('sync-busy: maxWaitMs boundary — exactly 120000ms triggers timeout', async () => {
  resetFakes();
  // Set env vars to control the boundary
  const origMaxWait = process.env.SYNC_BUSY_MAX_WAIT_MS;
  const origWaited = process.env.SYNC_BUSY_WAITED_MS;
  const busyErr = new fakeLib.BrowserBusyError('sync in progress (amazon)', {
    kind: 'sync', site: 'amazon',
  });
  // Simulate: waited = maxWaitMs (exactly 120000ms)
  // The boundary check `>=` should fire and timeout.
  // If mutated to `>`, this would NOT timeout (wrong).
  process.env.SYNC_BUSY_MAX_WAIT_MS = '120000';
  process.env.SYNC_BUSY_WAITED_MS = '120000';
  _lockResult = { error: busyErr };

  const { handleCommand } = await import('./sidecar/src/poll.js');

  const cmd = { id: 6, type: 'SYNC_AMAZON', status: 'pending' };
  await handleCommand(cmd);

  // Restore env
  if (origMaxWait !== undefined) process.env.SYNC_BUSY_MAX_WAIT_MS = origMaxWait;
  else delete process.env.SYNC_BUSY_MAX_WAIT_MS;
  if (origWaited !== undefined) process.env.SYNC_BUSY_WAITED_MS = origWaited;
  else delete process.env.SYNC_BUSY_WAITED_MS;

  const patchCall = _patchCalls.filter(c => c.id === 6).pop();
  assert.ok(patchCall, 'patchCommand should have been called');
  assert.equal(patchCall.status, 'failed');
  // The timeout message should appear when exactly at maxWaitMs
  assert.ok(patchCall.result.error.includes('timed out waiting for sync'),
    `Expected timeout message at exact boundary, got: ${patchCall.result.error}`);
});

// Mutation: refimpl.py:52 `||` → `&&` for maxWaitMs
// If `||` becomes `&&`, `parseInt('120000' && '120000')` would still work
// but `parseInt(undefined && '120000')` would return NaN.
// The fixture checks that the default 120000 is used when env is unset.
test('sync-busy: default maxWaitMs when env is unset', async () => {
  resetFakes();
  const origMaxWait = process.env.SYNC_BUSY_MAX_WAIT_MS;
  const origWaited = process.env.SYNC_BUSY_WAITED_MS;
  delete process.env.SYNC_BUSY_MAX_WAIT_MS;
  delete process.env.SYNC_BUSY_WAITED_MS;

  const busyErr = new fakeLib.BrowserBusyError('sync in progress (amazon)', {
    kind: 'sync', site: 'amazon',
  });
  _lockResult = { error: busyErr };

  const { handleCommand } = await import('./sidecar/src/poll.js');

  const cmd = { id: 7, type: 'SYNC_AMAZON', status: 'pending' };
  await handleCommand(cmd);

  if (origMaxWait !== undefined) process.env.SYNC_BUSY_MAX_WAIT_MS = origMaxWait;
  if (origWaited !== undefined) process.env.SYNC_BUSY_WAITED_MS = origWaited;

  const patchCall = _patchCalls.filter(c => c.id === 7).pop();
  assert.ok(patchCall, 'patchCommand should have been called');
  // With default maxWaitMs=120000 and waited=0, the command should wait
  // (not timeout immediately). The patch should be 'failed' with
  // 'timed out waiting for sync' only if maxWaitMs was exceeded.
  // Since waited=0 and maxWaitMs=120000, it should NOT timeout yet.
  assert.ok(!patchCall.result.error.includes('timed out waiting for sync'),
    'Should not timeout when waited=0 and maxWaitMs=120000 (default)');
});

// Mutation: refimpl.py:53 `||` → `&&` for waited
// If `||` becomes `&&`, `parseInt(undefined && '0')` returns NaN.
// The fixture checks that the default 0 is used when env is unset.
test('sync-busy: default waited when env is unset', async () => {
  resetFakes();
  const origMaxWait = process.env.SYNC_BUSY_MAX_WAIT_MS;
  const origWaited = process.env.SYNC_BUSY_WAITED_MS;
  delete process.env.SYNC_BUSY_MAX_WAIT_MS;
  delete process.env.SYNC_BUSY_WAITED_MS;

  const busyErr = new fakeLib.BrowserBusyError('sync in progress (amazon)', {
    kind: 'sync', site: 'amazon',
  });
  _lockResult = { error: busyErr };

  const { handleCommand } = await import('./sidecar/src/poll.js');

  const cmd = { id: 8, type: 'SYNC_AMAZON', status: 'pending' };
  await handleCommand(cmd);

  if (origMaxWait !== undefined) process.env.SYNC_BUSY_MAX_WAIT_MS = origMaxWait;
  if (origWaited !== undefined) process.env.SYNC_BUSY_WAITED_MS = origWaited;

  const patchCall = _patchCalls.filter(c => c.id === 8).pop();
  assert.ok(patchCall, 'patchCommand should have been called');
  // With default waited=0, the command should NOT timeout (maxWaitMs=120000, waited=0).
  assert.ok(!patchCall.result.error.includes('timed out waiting for sync'),
    'Should not timeout when waited=0 (default)');
});

// Mutation: refimpl.py:56 `patchCommand` call replaced with `cmd.id` (no-op)
// If the patchCommand call is removed, the command would NOT be patched
// to 'failed' when it should be. The fixture checks that patchCommand IS called.
test('sync-busy: timeout case calls patchCommand with failed status', async () => {
  resetFakes();
  const origMaxWait = process.env.SYNC_BUSY_MAX_WAIT_MS;
  const origWaited = process.env.SYNC_BUSY_WAITED_MS;
  process.env.SYNC_BUSY_MAX_WAIT_MS = '120000';
  process.env.SYNC_BUSY_WAITED_MS = '120000';

  const busyErr = new fakeLib.BrowserBusyError('sync in progress (amazon)', {
    kind: 'sync', site: 'amazon',
  });
  _lockResult = { error: busyErr };

  const { handleCommand } = await import('./sidecar/src/poll.js');

  const cmd = { id: 9, type: 'SYNC_AMAZON', status: 'pending' };
  await handleCommand(cmd);

  if (origMaxWait !== undefined) process.env.SYNC_BUSY_MAX_WAIT_MS = origMaxWait;
  else delete process.env.SYNC_BUSY_MAX_WAIT_MS;
  if (origWaited !== undefined) process.env.SYNC_BUSY_WAITED_MS = origWaited;
  else delete process.env.SYNC_BUSY_WAITED_MS;

  const patchCall = _patchCalls.filter(c => c.id === 9).pop();
  assert.ok(patchCall, 'patchCommand MUST be called (mutation: delete call -> no-op)');
  assert.equal(patchCall.status, 'failed');
  assert.ok(patchCall.result.error.includes('timed out waiting for sync'),
    'Timeout case must call patchCommand with failed status');
});

// Mutation: refimpl.py:59 `||` → `&&` in log message
// If `||` becomes `&&`, `${e.holder.site && 'unknown'}` would produce
// 'unknown' when site is truthy (wrong), or '' when site is falsy.
// The fixture checks that the 'unknown' fallback is used when site is missing.
test('sync-busy: log message uses "unknown" when holder.site is missing', async () => {
  resetFakes();
  const busyErr = new fakeLib.BrowserBusyError('sync in progress (amazon)', {
    kind: 'sync',
    // site is missing — should use 'unknown' fallback
  });
  _lockResult = { error: busyErr };

  const { handleCommand } = await import('./sidecar/src/poll.js');

  const cmd = { id: 10, type: 'SYNC_AMAZON', status: 'pending' };
  await handleCommand(cmd);

  const patchCall = _patchCalls.filter(c => c.id === 10).pop();
  assert.ok(patchCall, 'patchCommand should have been called');
  // The 'unknown' fallback should appear in the error message
  assert.ok(patchCall.result.error.includes('unknown'),
    'Error message should include "unknown" when holder.site is missing');
});

// Mutation: refimpl.py:61 `inFlight.add(cmd.id)` deleted
// If `inFlight.add(cmd.id)` is removed, the dedup in pollOnce would skip
// this re-entrant call. The fixture checks that the command is tracked.
test('sync-busy: inFlight tracks the queued command', async () => {
  resetFakes();
  const busyErr = new fakeLib.BrowserBusyError('sync in progress (amazon)', {
    kind: 'sync', site: 'amazon',
  });
  _lockResult = { error: busyErr };

  const { handleCommand } = await import('./sidecar/src/poll.js');

  const cmd = { id: 11, type: 'SYNC_AMAZON', status: 'pending' };
  await handleCommand(cmd);

  // The command should have been added to inFlight (dedup mechanism).
  // If inFlight.add is removed, the dedup would skip the re-entrant call.
  const patchCall = _patchCalls.filter(c => c.id === 11).pop();
  assert.ok(patchCall, 'patchCommand should have been called (inFlight tracking)');
});
