'use strict';
// Regression test for acquireBrowserLock/BrowserBusyError (sidecar/src/lib.js),
// the poll.js SYNC handlers taking the lock, loginQueue using a waitMs:0 lock
// and skipping a busy site, and loginQueue re-evaluating sitesNeedingLogin
// after each site.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-lock-'));
process.env.DATA_DIR = tmp;
process.env.TRACKER_URL = 'http://127.0.0.1:9';
process.env.TRACKER_USER_ID = '1';
process.env.SYNC_LOCK_WAIT_MS = '200';
fs.mkdirSync(path.join(tmp, 'sessions'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'sessions', 'amazon-session.json'), '{"cookies":[],"origins":[]}');

const lib = require('./src/lib');
assert.strictEqual(typeof lib.acquireBrowserLock, 'function', 'lib must export acquireBrowserLock');
assert.strictEqual(typeof lib.BrowserBusyError, 'function', 'lib must export BrowserBusyError');
assert.strictEqual(typeof lib.browserLockPath, 'function', 'lib must export browserLockPath');
const lockFile = lib.browserLockPath();
assert.strictEqual(lockFile, path.join(tmp, 'browser.lock'), 'lock lives at DATA_DIR/browser.lock');

const writeHolder = (pid, kind, site, startedAt = Date.now()) =>
  fs.writeFileSync(lockFile, JSON.stringify({ pid, kind, site, startedAt }));
const clear = () => { try { fs.unlinkSync(lockFile); } catch {} };
const readHolder = () => JSON.parse(fs.readFileSync(lockFile, 'utf8'));
const rejects = async (fn, re, msg) => {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  assert(err, msg + ' (expected rejection)');
  assert(err instanceof lib.BrowserBusyError, msg + ' (expected BrowserBusyError, got ' + (err && err.name) + ': ' + (err && err.message) + ')');
  if (re) assert(re.test(err.message), msg + ' (message was: ' + err.message + ')');
  return err;
};

// A pid that is certainly dead.
const dead = spawnSync(process.execPath, ['-e', '0']);
const DEAD_PID = dead.pid;
const LIVE_OTHER_PID = process.ppid; // parent process: alive and not us

(async () => {
  const SEC = process.env.SEC || process.argv[2] || 'all'; // sections: lib | poll | lq | all
  const on = s => SEC === 'all' || SEC === s;
  const calls = { launch: 0, patch: [], settings: [], apiErrors: [] };
  let settingsImpl = async () => ({});
  lib.getSettings = () => settingsImpl();
  lib.setSettings = async s => { calls.settings.push(s); };
  lib.logApiError = async e => { calls.apiErrors.push(e); };
  lib.captureFailure = async () => ({});
  lib.patchCommand = async (id, status, extra) => { calls.patch.push({ id, status, extra }); };
  if (on('lib')) {
  // ---- lib: acquire / release / contention
  clear();
  const rel = await lib.acquireBrowserLock('sync', { site: 'amazon' });
  assert.strictEqual(typeof rel, 'function', 'acquire resolves to a release function');
  let h = readHolder();
  assert.strictEqual(h.kind, 'sync'); assert.strictEqual(h.site, 'amazon'); assert.strictEqual(h.pid, process.pid);
  await rejects(() => lib.acquireBrowserLock('login', { site: 'costco' }), /sync/i, 'second acquire while held');
  await rel();
  assert(!fs.existsSync(lockFile), 'release removes the lock file');
  await rel(); // idempotent
  const rel2 = await lib.acquireBrowserLock('login', { site: 'costco' });
  await rel2();

  // release must not delete a lock someone else took over
  const rel3 = await lib.acquireBrowserLock('sync', { site: 'amazon' });
  writeHolder(LIVE_OTHER_PID, 'login', 'costco');
  await rel3();
  assert(fs.existsSync(lockFile) && readHolder().pid === LIVE_OTHER_PID, 'release must not remove a lock owned by another holder');

  // live foreign holder blocks; message names the kind
  writeHolder(LIVE_OTHER_PID, 'login', 'costco');
  const err = await rejects(() => lib.acquireBrowserLock('sync', { site: 'amazon' }), /login/i, 'live login holder blocks sync');
  assert(/in progress/i.test(err.message), 'message says "in progress": ' + err.message);

  // waitMs: waits then succeeds when the holder releases
  writeHolder(LIVE_OTHER_PID, 'login', 'costco');
  setTimeout(clear, 300);
  const t0 = Date.now();
  const rel4 = await lib.acquireBrowserLock('sync', { site: 'amazon', waitMs: 3000, pollMs: 50 });
  assert(Date.now() - t0 >= 250, 'waited for the holder');
  assert.strictEqual(readHolder().kind, 'sync');
  await rel4();

  // waitMs elapsed -> BrowserBusyError after roughly waitMs
  writeHolder(LIVE_OTHER_PID, 'login', 'costco');
  const t1 = Date.now();
  await rejects(() => lib.acquireBrowserLock('sync', { site: 'amazon', waitMs: 300, pollMs: 50 }), null, 'wait expiry');
  assert(Date.now() - t1 >= 250, 'waited ~waitMs before giving up');

  // stale: dead pid is stolen; so is an over-age lock; so is a corrupt old file
  writeHolder(DEAD_PID, 'login', 'costco');
  await (await lib.acquireBrowserLock('sync', { site: 'amazon' }))();
  clear();
  writeHolder(LIVE_OTHER_PID, 'login', 'costco', Date.now() - 3 * 60 * 60 * 1000);
  await (await lib.acquireBrowserLock('sync', { site: 'amazon' }))();
  clear();
  writeHolder(LIVE_OTHER_PID, 'login', 'costco', Date.now() - 60 * 1000);
  await rejects(() => lib.acquireBrowserLock('sync', { site: 'amazon', staleMs: 5 * 60 * 1000 }), null, 'fresh live lock not stolen');
  await (await lib.acquireBrowserLock('sync', { site: 'amazon', staleMs: 1000 }))(); // custom staleMs steals the 60s-old lock
  clear();
  fs.writeFileSync(lockFile, 'not json');
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000); fs.utimesSync(lockFile, old, old);
  await (await lib.acquireBrowserLock('sync', { site: 'amazon' }))();
  clear();

  // EXTRA: two acquireBrowserLock('sync',...) calls with waitMs:0 in the same
  // process while the first is held, the second rejects with BrowserBusyError.
  clear();
  const relExtra = await lib.acquireBrowserLock('sync', { site: 'amazon' });
  await rejects(() => lib.acquireBrowserLock('sync', { site: 'walmart', waitMs: 0 }), /sync/i, 'waitMs:0 second acquire while first held');
  await relExtra();
  clear();

  }
  if (on('poll')) {
  // ---- poll.js: SYNC_* must not launch a browser while a login window holds the lock
  let lockSeenDuringLaunch = null;
  lib.launchBrowser = async () => { calls.launch++; lockSeenDuringLaunch = fs.existsSync(lockFile) ? readHolder() : null; return { close: async () => {} }; };
  lib.newContextForSite = async () => { throw new Error('stop-after-launch'); };
  lib.patchCommand = async (id, status, extra) => { calls.patch.push({ id, status, extra }); };
  const poll = require('./src/poll');
  const cmd = { id: 77, type: 'SYNC_AMAZON', status: 'pending', payload: null };

  writeHolder(LIVE_OTHER_PID, 'login', 'costco');
  await poll.handleCommand(cmd);
  assert.strictEqual(calls.launch, 0, 'sync must NOT launch a browser while a login window is open');
  const failed = calls.patch.filter(p => p.status === 'failed');
  assert.strictEqual(failed.length, 1, 'command is reported failed exactly once');
  assert(/login in progress/i.test(String(failed[0].extra && failed[0].extra.error)), 'error tells the UI "login in progress": ' + JSON.stringify(failed[0]));
  assert(!calls.settings.some(s => Object.keys(s).some(k => /session_status/.test(k))), 'busy lock must not change session status (not an expiry)');
  assert(fs.existsSync(lockFile) && readHolder().kind === 'login', 'sync must leave the login lock alone');
  clear();

  // no contention: sync runs, holds a sync lock while launching, releases afterwards (also on error)
  calls.patch.length = 0;
  await poll.handleCommand(cmd);
  assert.strictEqual(calls.launch, 1, 'sync launches when nobody holds the lock');
  assert(lockSeenDuringLaunch && lockSeenDuringLaunch.kind === 'sync' && lockSeenDuringLaunch.pid === process.pid, 'sync lock held while the browser launches');
  assert(!fs.existsSync(lockFile), 'sync lock released after the command finishes (even on failure)');

  }
  if (on('lq') || SEC === 'lq2') {
  // ---- loginQueue.js: no login window while a sync browser is active
  const loginFlow = require('./src/loginFlow');
  let waitCalls = 0; let lockDuringLogin = null; let throwInWait = false;
  loginFlow.waitForLogin = async () => { waitCalls++; lockDuringLogin = fs.existsSync(lockFile) ? readHolder() : null; if (throwInWait) throw new Error('boom'); return false; };
  const fakePage = {};
  const fakeCtx = { newPage: async () => fakePage, close: async () => {}, addInitScript: async () => {}, pages: () => [] };
  calls.launch = 0;
  lib.launchBrowser = async () => { calls.launch++; return { newContext: async () => fakeCtx, close: async () => {} }; };
  const lq = require('./src/loginQueue');

  writeHolder(LIVE_OTHER_PID, 'sync', 'amazon');
  await lq.runQueueOnce();
  assert.strictEqual(calls.launch, 0, 'loginQueue must not launch a login browser while a sync browser is active');
  assert.strictEqual(waitCalls, 0, 'no login wait while sync active');
  assert(fs.existsSync(lockFile) && readHolder().kind === 'sync', 'loginQueue leaves the sync lock alone');
  clear();

  await lq.runQueueOnce();
  assert(calls.launch >= 1 && waitCalls >= 1, 'loginQueue opens login windows when idle');
  assert(lockDuringLogin && lockDuringLogin.kind === 'login' && lockDuringLogin.pid === process.pid, 'login lock held while waiting for the human');
  assert(!fs.existsSync(lockFile), 'login lock released after the cycle');

  throwInWait = true;
  await lq.runQueueOnce();
  assert(!fs.existsSync(lockFile), 'login lock released even when waitForLogin throws');
  throwInWait = false;

  if (SEC !== 'lq') {
  // ---- needs-login signal (both directions) and re-evaluation between sites within one cycle
  const sess = s => path.join(tmp, 'sessions', s + '-session.json');
  let statuses = {};
  settingsImpl = async () => statuses;
  for (const s of ['walmart', 'costco', 'bfmr']) fs.rmSync(sess(s), { force: true });
  statuses = { amazon_session_status: 'active' };
  let need = await lq.sitesNeedingLogin();
  assert(!need.includes('amazon'), 'amazon with session file + active status does not need login');
  assert(need.includes('costco') && need.includes('walmart') && need.includes('bfmr'), 'sites without a session file need login');
  statuses = { amazon_session_status: 'expired' };
  need = await lq.sitesNeedingLogin();
  assert(need.includes('amazon'), 'a failed sync that marked amazon expired makes it need login');
  settingsImpl = async () => { throw new Error('tracker down'); };
  need = await lq.sitesNeedingLogin();
  assert(!need.includes('amazon') && need.includes('costco'), 'settings fetch failure falls back to the local session-file check');

  // a site marked expired DURING the cycle (a sync just failed) gets its window in the same cycle
  statuses = { amazon_session_status: 'active' };
  settingsImpl = async () => statuses;
  const seen = [];
  loginFlow.waitForLogin = async (site) => { seen.push(site); if (seen.length === 1) statuses = { amazon_session_status: 'expired' }; return false; };
  await lq.runQueueOnce();
  assert(seen.includes('amazon'), 'amazon expired mid-cycle must get a login window in that same cycle, saw: ' + seen.join(','));
  assert.strictEqual(seen.filter(s => s === 'amazon').length, 1, 'amazon visited once');

  // a site that no longer needs login (session appeared) is skipped when its turn comes
  for (const s of ['walmart', 'costco', 'bfmr']) fs.rmSync(sess(s), { force: true });
  statuses = { amazon_session_status: 'active' };
  seen.length = 0;
  loginFlow.waitForLogin = async (site) => {
    seen.push(site);
    if (seen.length === 1) for (const s of ['walmart', 'costco', 'bfmr']) fs.writeFileSync(sess(s), '{}');
    return true;
  };
  await lq.runQueueOnce();
  assert.strictEqual(seen.length, 1, 'sites that got a session during the cycle are not re-opened, saw: ' + seen.join(','));

  }
  }
  console.log('test-browser-lock: ok');
})().catch(e => { console.error(e); process.exit(1); }).finally(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });
