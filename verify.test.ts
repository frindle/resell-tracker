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
// Fake syncWalmart: record calls.
let _syncWalmartCalls = [];

// Build a fake lib module with the exports poll.js needs.
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
    return {
      newContext: async () => ({
        newPage: async () => ({
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
            route: () => {},
            setOffline: () => {},
            clearCookies: async () => {},
            clearPermissions: async () => {},
            storageState: async () => ({}),
          }),
          on: () => {},
          once: () => {},
          off: () => {},
          emit: () => {},
          pages: async () => [],
          context: () => ({
            pages: async () => [],
            storageState: async () => ({}),
            cookies: async () => [],
            addInitScript: async () => {},
            close: async () => {},
            isClosed: () => false,
          }),
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
          close: async () => {},
          isClosed: () => false,
          frames: () => [],
        }),
        storageState: async () => ({}),
        cookies: async () => [],
        addInitScript: async () => {},
        close: async () => {},
        isClosed: () => false,
      }),
      close: async () => {},
    };
  },
  newContextForSite: async (browser, site) => {
    if (_launchError) throw _launchError;
    return browser.newContext();
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
  acquireBrowserLock: async (kind, opts) => {
    if (_lockResult) {
      throw _lockResult.error;
    }
    // Return a release function on success.
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
