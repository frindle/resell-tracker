'use strict';
// Frozen acceptance test: when a sync hits Amazon's bot-check interstitial (AmazonBlockedError), handleCommand
// (sidecar/src/poll.js) must stop, surface an actionable "needs a manual Continue click" state and never retry
// or click anything. Sign-in expiry and ordinary failures keep their existing states.
const test = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-block-'));
process.env.DATA_DIR = tmp;
process.env.TRACKER_URL = 'http://127.0.0.1:9';
process.env.TRACKER_USER_ID = '1';
process.env.SYNC_LOCK_WAIT_MS = '200';

try { require.resolve('playwright-core'); } catch (_) {
  const Module = require('module');
  const origLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'playwright-core') return { chromium: {} };
    return origLoad.call(this, request, ...rest);
  };
}

const lib = require('./src/lib');
const patches = [];
const settingsWrites = [];
const apiErrors = [];
const captureLabels = [];
let browserLaunches = 0;
const fakePage = { on() {}, off() {}, goto: async () => {}, close: async () => {}, isClosed: () => false, url: () => '' };
const fakeCtx = { newPage: async () => fakePage, pages: () => [fakePage], close: async () => {}, storageState: async () => ({}), addInitScript: async () => {} };
lib.hasSession = () => true;
lib.patchCommand = async (id, status, extra) => { patches.push({ id, status, extra }); };
lib.setSettings = async s => { settingsWrites.push(s); };
lib.getSettings = async () => ({});
lib.logApiError = async e => { apiErrors.push(e); };
lib.captureFailure = async (page, site, label) => { captureLabels.push(label); return { screenshot: '/data/debug/amazon-x.png', html: '/data/debug/amazon-x.html' }; };
lib.launchBrowser = async () => { browserLaunches++; return { close: async () => {} }; };
lib.newContextForSite = async () => fakeCtx;
lib.fetchMissingTrackingOrderNumbers = async () => [];

const poll = require('./src/poll');
const [type, cfg] = Object.entries(poll.SITES).find(([, c]) => c.site === 'amazon' && c.kind !== 'sessionless');
cfg.prepareContext = undefined;
cfg.sink = undefined;
let runs = 0;
let thrower = null;
cfg.run = async () => { runs++; throw thrower; };

function reset(err) { patches.length = 0; settingsWrites.length = 0; apiErrors.length = 0; captureLabels.length = 0; runs = 0; browserLaunches = 0; thrower = err; }
const failedPatch = () => patches.filter(p => p.status === 'failed').pop();
const mergedSettings = () => Object.assign({}, ...settingsWrites);

test('a bot-check block stops the sync with an actionable manual-Continue state', async () => {
  const before = Date.now();
  reset(new lib.AmazonBlockedError('amazon'));
  await poll.handleCommand({ id: 11, type, payload: '{}' });

  assert.strictEqual(runs, 1, 'the sync body runs once and is never retried');
  assert.strictEqual(browserLaunches, 1, 'no second browser launch / retry');
  assert.strictEqual(patches.filter(p => p.status === 'failed').length, 1);
  assert.ok(!patches.some(p => p.status === 'done'));
  const f = failedPatch();
  assert.match(f.extra.error, /Amazon needs a manual Continue click/);
  assert.ok(f.extra.error.length > 20 && f.extra.error.length <= 160, 'the status panel truncates at 160 chars, keep the whole message visible');
  assert.strictEqual(f.extra.blocked, true);
  const at = Date.parse(f.extra.blockedAt);
  assert.ok(Number.isFinite(at) && at >= before - 1000 && at <= Date.now() + 1000, 'blockedAt is an ISO timestamp of now: ' + f.extra.blockedAt);
  assert.ok(String(f.extra.liveViewPath).startsWith('/vnc/vnc.html'), 'links the existing noVNC live view: ' + f.extra.liveViewPath);
  assert.strictEqual(f.extra.screenshot, '/data/debug/amazon-x.png', 'debug artifacts are still attached');
  assert.strictEqual(f.extra.html, '/data/debug/amazon-x.html');
  assert.deepStrictEqual(captureLabels.length, 1);
  assert.match(captureLabels[0], /block/i, 'artifact label names the block, not session-expired');
});

test('a block is its own session status: not expired (no login window) and not active', async () => {
  reset(new lib.AmazonBlockedError('amazon'));
  await poll.handleCommand({ id: 12, type, payload: '{}' });
  const s = mergedSettings();
  assert.strictEqual(s.amazon_session_status, 'blocked');
  assert.ok(Number.isFinite(Date.parse(s.amazon_session_checked_at)));
  assert.strictEqual(apiErrors.length, 1);
  assert.match(apiErrors[0].context, /manual Continue click/);
  assert.ok(!/docker exec|login\.js/.test(apiErrors[0].context), 'must not tell the user to re-run the interactive login');
});

test('sign-in expiry and ordinary failures keep their existing states', async () => {
  reset(new lib.SessionExpiredError('amazon'));
  await poll.handleCommand({ id: 13, type, payload: '{}' });
  assert.strictEqual(mergedSettings().amazon_session_status, 'expired');
  assert.strictEqual(failedPatch().extra.blocked, undefined);
  assert.ok(!/Continue click/.test(failedPatch().extra.error));
  assert.deepStrictEqual(captureLabels, ['session-expired']);

  reset(new Error('boom'));
  await poll.handleCommand({ id: 14, type, payload: '{}' });
  assert.strictEqual(mergedSettings().amazon_session_status, 'active');
  assert.strictEqual(failedPatch().extra.error, 'boom');
  assert.strictEqual(failedPatch().extra.blocked, undefined);
  assert.deepStrictEqual(captureLabels, ['sync-failed']);
});

test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });
