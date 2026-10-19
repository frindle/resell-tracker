'use strict';
// Regression: when a lock looks live at first (pid alive, mtime fresh) but goes stale
// during the waitMs wait, the post-wait path must reclaim the stale lock instead of
// throwing EEXIST from writeLock(flag:'wx').
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { test } = require('node:test');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-stale-'));
process.env.DATA_DIR = tmp;
process.env.TRACKER_URL = 'http://127.0.0.1:9';
process.env.TRACKER_USER_ID = '1';
const lib = require('./src/lib');
const lockFile = lib.browserLockPath();
fs.mkdirSync(tmp, { recursive: true });

const writeHolder = (pid, kind, site, startedAt = Date.now(), token = null) => {
  const data = JSON.stringify({ pid, kind, site, startedAt, token });
  fs.writeFileSync(lockFile, data);
};
const clear = () => { try { fs.unlinkSync(lockFile); } catch {} };

// Test 1: stale-after-wait — lock is live at first (fresh mtime), becomes stale
// during the waitMs wait, must be reclaimed (not throw EEXIST).
test('stale-after-wait reclaims the lock', async () => {
  const LIVE_PID = process.ppid; // alive outside this process
  const oldToken = 'oldtoken0000000000000000000000000000'; // 32 hex chars
  // Write lock with FRESH mtime (just now) so first check sees it as not stale
  writeHolder(LIVE_PID, 'login', 'costco', Date.now(), oldToken);
  // Do NOT set mtime in the past — it stays fresh so first check returns the holder.
  // During the wait loop (waitMs=500, pollMs=50), the mtime ages past
  // heartbeatStaleMs=200, making checkFile return 'stale' after the wait.

  // First check sees a live holder (pid alive, mtime < staleMs AND < heartbeatStaleMs),
  // enters the wait loop. During wait, mtime ages past heartbeatStaleMs (200ms).
  // After wait: checkFile returns 'stale'. Current code breaks and calls writeLock
  // which throws EEXIST because the file still exists.
  let err = null;
  let release = null;
  try {
    release = await lib.acquireBrowserLock('sync', {
      site: 'amazon',
      waitMs: 500,
      pollMs: 50,
      heartbeatMs: 100000,
      heartbeatStaleMs: 200
    });
  } catch (e) {
    err = e;
  }

  // Current behavior: throws EEXIST (AssertionError: expected null)
  assert(err === null, 'stale-after-wait must resolve to a release function, got error: ' + (err ? err.message : 'null'));
  assert(typeof release === 'function', 'must return a release function');

  // Verify the lock was reclaimed: file exists with our pid and a different token
  const holder = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  assert.strictEqual(holder.pid, process.pid, 'reclaimed lock must have our pid');
  assert.notStrictEqual(holder.token, oldToken, 'reclaimed lock must have a different token');

  // Release removes the file
  await release();
  assert(!fs.existsSync(lockFile), 'release must remove the lock file');

  // Cleanup
  clear();
});

// Test 2: fresh live lock with waitMs:0 still rejects with BrowserBusyError.
test('fresh-live-lock-with-waitMs-zero still throws BrowserBusyError', async () => {
  const LIVE_PID = process.ppid; // alive outside this process
  writeHolder(LIVE_PID, 'login', 'costco', Date.now(), 'freshtoken0000000000000000000000000000');
  // mtime is fresh (just written)

  let err = null;
  try {
    await lib.acquireBrowserLock('sync', { site: 'amazon', waitMs: 0, pollMs: 50 });
  } catch (e) {
    err = e;
  }

  assert(err instanceof lib.BrowserBusyError, 'fresh live lock must reject with BrowserBusyError');
  assert(/in progress/i.test(err.message), 'BrowserBusyError message must mention "in progress"');

  // Cleanup
  clear();
});

// Cleanup temp dir after all tests
setTimeout(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }, 1000);
