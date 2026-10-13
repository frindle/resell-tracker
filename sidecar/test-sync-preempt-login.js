'use strict';
// Regression: a SYNC_* command blocked by an idle LOGIN window requests preemption,
// waits a bounded time for the lock, then proceeds; an active login window (the holder
// never releases) is NOT preempted and the sync fails with the usual message.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-sp-'));
process.env.DATA_DIR = tmp;
process.env.TRACKER_URL = 'http://127.0.0.1:9';
process.env.TRACKER_USER_ID = '1';
process.env.SYNC_LOCK_WAIT_MS = '200';
process.env.LOGIN_PREEMPT_WAIT_MS = '1500';

const lib = require('./src/lib');
const patches = [];
let ran = 0;
const fakePage = { on() {}, off() {}, goto: async () => {}, close: async () => {}, isClosed: () => false, url: () => '' };
const fakeCtx = { newPage: async () => fakePage, pages: () => [fakePage], close: async () => {}, storageState: async () => ({}), addInitScript: async () => {} };
lib.hasSession = () => true;
lib.patchCommand = async (id, status, extra) => { patches.push({ id, status, extra }); };
lib.setSettings = async () => {};
lib.getSettings = async () => ({});
lib.logApiError = async () => {};
lib.captureFailure = async () => ({});
lib.launchBrowser = async () => ({ close: async () => {} });
lib.newContextForSite = async () => fakeCtx;
lib.fetchMissingTrackingOrderNumbers = async () => [];

const cd = require('./src/loginCooldown');
let requestCalls = 0;
const realRequest = cd.requestPreempt;
cd.requestPreempt = (...a) => { requestCalls++; return realRequest(...a); };
const poll = require('./src/poll');
const [type, cfg] = Object.entries(poll.SITES).find(([, c]) => c.site === 'amazon' && c.kind !== 'sessionless');
cfg.prepareContext = undefined;
cfg.sink = undefined;
cfg.run = async () => { ran++; return []; };

const lockFile = lib.browserLockPath();
function holdLock(kind, site) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, kind, site, startedAt: Date.now(), token: 'holder' }));
}
function resetAll() { try { fs.unlinkSync(lockFile); } catch {} cd.clearPreemptRequest('costco'); cd.clearCooldown('costco'); patches.length = 0; ran = 0; requestCalls = 0; }
const last = () => patches[patches.length - 1];

(async () => {
  // 1. idle login holder honors the request after ~300ms and releases the lock
  resetAll();
  holdLock('login', 'costco');
  let sawRequest = false;
  const poller = setInterval(() => {
    if (cd.isPreemptRequested('costco')) {
      sawRequest = true; clearInterval(poller);
      setTimeout(() => { cd.clearPreemptRequest('costco'); cd.recordPreempt('costco'); try { fs.unlinkSync(lockFile); } catch {} }, 300);
    }
  }, 25);
  await poll.handleCommand({ id: 1, type, payload: '{}' });
  clearInterval(poller);
  assert(sawRequest && requestCalls === 1, 'sync must request preemption of the idle login window exactly once');
  assert.strictEqual(ran, 1, 'sync proceeds after the lock is released');
  assert.strictEqual(last().status, 'done', JSON.stringify(last()));
  assert(cd.getCooldown('costco'), 'holder recorded post-preempt cooldown (queue will not reopen)');
  assert(!fs.existsSync(lockFile), 'sync released the lock when done');

  // 2. active login window: holder never releases -> not preempted, original error, request withdrawn
  resetAll();
  holdLock('login', 'costco');
  const t0 = Date.now();
  await poll.handleCommand({ id: 2, type, payload: '{}' });
  assert.strictEqual(ran, 0, 'sync must not run');
  assert.strictEqual(last().status, 'failed');
  assert(/login in progress \(costco\)/.test(last().extra.error) && /try again when the login window is closed/.test(last().extra.error), last().extra.error);
  assert(Date.now() - t0 >= 1400 && Date.now() - t0 < 6000, 'bounded wait, took ' + (Date.now() - t0));
  assert.strictEqual(cd.isPreemptRequested('costco'), false, 'request withdrawn after giving up');
  assert(fs.existsSync(lockFile), 'lock not stolen from an active window');

  // 3. a non-login holder (another sync) is never preempted
  resetAll();
  holdLock('sync', 'costco');
  await poll.handleCommand({ id: 3, type, payload: '{}' });
  assert.strictEqual(requestCalls, 0, 'never even asks a sync holder to close');
  assert.strictEqual(cd.isPreemptRequested('costco'), false, 'no preempt request for a sync holder');
  assert.strictEqual(ran, 0);
  assert.strictEqual(last().status, 'failed');

  resetAll();
  console.log('test-sync-preempt-login: ok');
})().catch(e => { console.error(e); process.exit(1); }).finally(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });
