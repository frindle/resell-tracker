'use strict';
// Regression: a non-BrowserBusyError from acquireBrowserLock (e.g. EEXIST) must mark the
// command failed instead of leaving it 'running' forever. Covers all three acquire sites.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-lockerr-'));
process.env.TRACKER_URL = 'http://127.0.0.1:9';
process.env.TRACKER_USER_ID = '1';

const lib = require('./src/lib');
const patches = [];
let script = [];
lib.hasSession = () => true;
lib.patchCommand = async (id, status, extra) => { patches.push({ id, status, extra }); };
lib.setSettings = async () => {};
lib.logApiError = async () => {};
lib.acquireBrowserLock = async () => {
  const next = script.shift();
  if (!next) throw new Error('unexpected extra acquire');
  throw next;
};

const poll = require('./src/poll');
const [type] = Object.entries(poll.SITES).find(([, c]) => c.site === 'amazon' && c.kind !== 'sessionless');
const eexist = () => Object.assign(new Error("EEXIST: file already exists, open '/data/browser.lock'"), { code: 'EEXIST' });
const busy = (kind) => new lib.BrowserBusyError({ pid: 1, kind, site: 'costco' });

async function run(name, errs) {
  patches.length = 0;
  script = errs;
  await poll.handleCommand({ id: 7, type, payload: '{}' });
  const last = patches[patches.length - 1];
  assert.ok(last, `${name}: command was never patched`);
  assert.strictEqual(last.status, 'failed', `${name}: expected failed, got ${last.status}`);
  assert.match(last.extra.error, /EEXIST/, `${name}: error should carry the lock error`);
}

(async () => {
  await run('first acquire throws EEXIST', [eexist()]);
  await run('sync holder, retry throws EEXIST', [busy('sync'), eexist()]);
  await run('login holder, preempt retry throws EEXIST', [busy('login'), eexist()]);
  console.log('ok');
})().catch((e) => { console.error(e); process.exit(1); });
