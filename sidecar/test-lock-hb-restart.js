'use strict';
// Regression: a browser.lock left on the persistent /data volume by a previous
// container run must not block forever. The holder pid can be alive in the new
// container (pids restart low and get reused), so liveness by pid alone is not
// enough; a live holder must keep a heartbeat (lock file mtime) fresh.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-lock-hb-'));
process.env.DATA_DIR = tmp;
process.env.TRACKER_URL = 'http://127.0.0.1:9';
process.env.TRACKER_USER_ID = '1';
const lib = require('./src/lib');
const lockFile = lib.browserLockPath();
const LIVE_OTHER_PID = process.ppid; // alive, not us
const readHolder = () => JSON.parse(fs.readFileSync(lockFile, 'utf8'));
const age = ms => { const t = new Date(Date.now() - ms); fs.utimesSync(lockFile, t, t); };

(async () => {
  // 1. previous-run lock: live pid, started 2 min ago, but nobody heartbeats it
  fs.writeFileSync(lockFile, JSON.stringify({ pid: LIVE_OTHER_PID, kind: 'login', site: 'costco', startedAt: Date.now() - 2 * 60 * 1000 }));
  age(2 * 60 * 1000);
  const rel = await lib.acquireBrowserLock('login', { site: 'costco', heartbeatMs: 100 }); // must NOT throw BrowserBusyError
  assert.strictEqual(readHolder().pid, process.pid, 'stale-heartbeat lock was taken over');

  // 2. our own held lock heartbeats: mtime stays fresh while held
  age(60 * 1000);
  const before = fs.statSync(lockFile).mtimeMs;
  await new Promise(r => setTimeout(r, 600));
  const after = fs.statSync(lockFile).mtimeMs;
  assert(after > before + 30 * 1000, 'held lock must refresh its mtime heartbeat (before=' + before + ' after=' + after + ')');
  await rel();
  assert(!fs.existsSync(lockFile), 'release removes the lock');

  // 3. a live holder with a fresh heartbeat still blocks
  fs.writeFileSync(lockFile, JSON.stringify({ pid: LIVE_OTHER_PID, kind: 'login', site: 'costco', startedAt: Date.now() - 2 * 60 * 1000 }));
  let err = null;
  try { await lib.acquireBrowserLock('sync', { site: 'amazon' }); } catch (e) { err = e; }
  assert(err instanceof lib.BrowserBusyError, 'fresh heartbeat from live holder still blocks');
  fs.unlinkSync(lockFile);
  console.log('test-browser-lock-heartbeat: ok');
})().catch(e => { console.error(e); process.exit(1); }).finally(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });
