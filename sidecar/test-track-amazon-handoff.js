'use strict';
// TRACK_AMAZON: the sidecar tries an Amazon order's tracking page first. When
// Amazon blocks it, or it has no session, or the run fails, the same orders
// are queued for the browser extension (targetBrowser 'chrome') instead of
// raising the "click Continue" alert. The block is still recorded so the
// tracker skips the sidecar for a day. Another user's orders are refused.
const test = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-track-'));
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
const queued = [];
let session = true;
const fakePage = { on() {}, off() {}, goto: async () => {}, close: async () => {}, isClosed: () => false, url: () => '' };
const fakeCtx = { newPage: async () => fakePage, pages: () => [fakePage], close: async () => {}, storageState: async () => ({}), addInitScript: async () => {} };
lib.hasSession = () => session;
lib.patchCommand = async (id, status, extra) => { patches.push({ id, status, extra }); };
lib.setSettings = async s => { settingsWrites.push(s); };
lib.getSettings = async () => ({});
lib.logApiError = async e => { apiErrors.push(e); };
lib.captureFailure = async () => ({});
lib.launchBrowser = async () => ({ close: async () => {} });
lib.newContextForSite = async () => fakeCtx;
lib.fetchMissingTrackingOrderNumbers = async () => [];
lib.queueCommand = async (type, payload, target) => { queued.push({ type, payload, target }); return { id: 99 }; };
let pushed = [];
lib.pushOrders = async orders => { pushed = orders; return { imported: 0, updated: orders.length, skipped: 0 }; };

const poll = require('./src/poll');
const cfg = poll.SITES.TRACK_AMAZON;
assert.ok(cfg && cfg.tracking, 'TRACK_AMAZON is a tracking command');
let outcome;
cfg.run = async () => { if (outcome instanceof Error) throw outcome; return outcome; };

function reset(o) { patches.length = 0; settingsWrites.length = 0; apiErrors.length = 0; queued.length = 0; pushed = []; session = true; outcome = o; }
const payload = JSON.stringify({ orderNumbers: ['111-1', '111-2'], userId: 1 });
const last = st => patches.filter(p => p.status === st).pop();
const merged = () => Object.assign({}, ...settingsWrites);

test('a block hands the orders to the extension, records the block, no Continue alert', async () => {
  reset(new lib.AmazonBlockedError('amazon'));
  await poll.handleCommand({ id: 1, type: 'TRACK_AMAZON', payload });
  assert.deepStrictEqual(queued, [{ type: 'TRACK_AMAZON', payload: { orderNumbers: ['111-1', '111-2'], userId: 1, from: 'sidecar', reason: 'blocked' }, target: 'chrome' }]);
  const f = last('failed');
  assert.strictEqual(f.extra.handedOff, true);
  assert.strictEqual(f.extra.blocked, true);
  assert.strictEqual(merged().amazon_session_status, 'blocked');
  assert.strictEqual(apiErrors.length, 0);
});

test('signed out or failing runs hand off too', async () => {
  reset(new lib.SessionExpiredError('amazon'));
  await poll.handleCommand({ id: 2, type: 'TRACK_AMAZON', payload });
  assert.strictEqual(queued[0].payload.reason, 'signed-out');
  assert.strictEqual(merged().amazon_session_status, 'expired');

  reset(new Error('boom'));
  await poll.handleCommand({ id: 3, type: 'TRACK_AMAZON', payload });
  assert.strictEqual(queued[0].payload.reason, 'error');
  assert.strictEqual(queued[0].target, 'chrome');
});

test('no saved session hands off without opening a browser', async () => {
  reset([]);
  session = false;
  await poll.handleCommand({ id: 4, type: 'TRACK_AMAZON', payload });
  assert.strictEqual(queued.length, 1);
  assert.strictEqual(queued[0].payload.reason, 'no-session');
  assert.strictEqual(last('failed').extra.handedOff, true);
});

test('a successful run imports and does not hand off', async () => {
  reset([{ platform: 'Amazon', orderNumber: '111-1', trackingNumbers: ['1Z999'] }]);
  await poll.handleCommand({ id: 5, type: 'TRACK_AMAZON', payload });
  assert.strictEqual(queued.length, 0);
  assert.strictEqual(pushed.length, 1);
  assert.ok(last('done'));
});

test("another user's orders are refused and never handed off", async () => {
  reset([]);
  await poll.handleCommand({ id: 6, type: 'TRACK_AMAZON', payload: JSON.stringify({ orderNumbers: ['111-1'], userId: 2 }) });
  assert.strictEqual(queued.length, 0);
  assert.match(last('failed').extra.error, /user 2/);
});

test('other Amazon commands keep the old block behaviour', async () => {
  const sync = poll.SITES.SYNC_AMAZON_ORDER;
  const orig = sync.run;
  sync.run = async () => { throw new lib.AmazonBlockedError('amazon'); };
  reset(null);
  await poll.handleCommand({ id: 7, type: 'SYNC_AMAZON_ORDER', payload });
  sync.run = orig;
  assert.strictEqual(queued.length, 0);
  assert.match(last('failed').extra.error, /manual Continue click/);
  assert.strictEqual(apiErrors.length, 1);
});

test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });
