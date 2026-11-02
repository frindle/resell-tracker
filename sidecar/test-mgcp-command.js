'use strict';
// SCRAPE_MGCP command wiring: needs an orderId, queues behind a running sync
// instead of failing, and releases the browser lock when done.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-mgcp-'));
process.env.DATA_DIR = tmp;
process.env.TRACKER_URL = 'http://127.0.0.1:9';
process.env.TRACKER_USER_ID = '1';
process.env.SYNC_LOCK_WAIT_MS = '200';

const lib = require('./src/lib');
const patches = [];
let fetched = 0;
lib.patchCommand = async (id, status, extra) => { patches.push({ id, status, extra }); };
lib.setSettings = async () => {};
lib.logApiError = async () => {};
lib.fetchMgcpLinks = async () => { fetched++; return { links: [] }; };
const poll = require('./src/poll');

const lockFile = lib.browserLockPath();
const last = () => patches[patches.length - 1];

(async () => {
  await poll.handleCommand({ id: 1, type: 'SCRAPE_MGCP', payload: '{}' });
  assert.strictEqual(last().status, 'failed');
  assert(/orderId/.test(last().extra.error));

  patches.length = 0;
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, kind: 'sync', site: 'amazon', startedAt: Date.now(), token: 'holder' }));
  setTimeout(() => { try { fs.unlinkSync(lockFile); } catch {} }, 700);
  const t0 = Date.now();
  await poll.handleCommand({ id: 2, type: 'SCRAPE_MGCP', payload: JSON.stringify({ orderId: 42 }) });
  assert(Date.now() - t0 >= 600, 'queued behind the running sync');
  assert(!patches.some(p => p.status === 'failed'), JSON.stringify(patches));
  assert.strictEqual(fetched, 1);
  assert.strictEqual(last().status, 'done');
  assert(!fs.existsSync(lockFile), 'lock released');
  console.log('test-mgcp-command: ok');
})().catch(e => { console.error(e); process.exit(1); }).finally(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });
