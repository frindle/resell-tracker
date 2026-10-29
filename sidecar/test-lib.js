'use strict';
// Frozen acceptance test for pruneDebugDir (sidecar/src/lib.js) and its wiring into captureFailure.
const test = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-prune-'));
process.env.DATA_DIR = tmp;
process.env.TRACKER_URL = 'http://127.0.0.1:9';
process.env.TRACKER_USER_ID = '1';
delete process.env.DEBUG_RETENTION_DAYS;

const lib = require('./src/lib');
const debugDir = path.join(tmp, 'debug');
const DAY = 86400000;

function reset() {
  fs.rmSync(debugDir, { recursive: true, force: true });
  fs.rmSync(path.join(tmp, 'sessions'), { recursive: true, force: true });
  fs.rmSync(path.join(tmp, 'outside.txt'), { force: true });
  delete process.env.DEBUG_RETENTION_DAYS;
}
function put(p, ageDays) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, 'x');
  const t = (Date.now() - ageDays * DAY) / 1000;
  fs.utimesSync(p, t, t);
  return p;
}
const dbg = (n, age) => put(path.join(debugDir, n), age);


test('deletes files older than 7 days, keeps newer, returns the count; missing dir returns 0', () => {
  reset();
  assert.strictEqual(fs.existsSync(debugDir), false);
  let none;
  assert.doesNotThrow(() => { none = lib.pruneDebugDir(); });
  assert.strictEqual(none, 0, 'missing debug dir returns 0');
  const oldPng = dbg('amazon-sync-failed-a.png', 8);
  const oldHtml = dbg('amazon-login-open-b.html', 8);
  const recent = dbg('amazon-sync-failed-c.png', 6);
  const n = lib.pruneDebugDir();
  assert.strictEqual(fs.existsSync(oldPng), false, '8-day-old png deleted');
  assert.strictEqual(fs.existsSync(oldHtml), false, '8-day-old html deleted');
  assert.strictEqual(fs.existsSync(recent), true, '6-day-old png kept');
  assert.strictEqual(n, 2, 'returns number deleted');
});

test('DEBUG_RETENTION_DAYS is read at call time; bad values fall back to 7', () => {
  reset();
  const f = dbg('a.png', 2);
  assert.strictEqual(lib.pruneDebugDir(), 0, 'default keeps a 2-day-old file');
  assert.strictEqual(fs.existsSync(f), true);
  process.env.DEBUG_RETENTION_DAYS = 'abc';
  assert.strictEqual(lib.pruneDebugDir(), 0, 'non-numeric falls back to 7');
  process.env.DEBUG_RETENTION_DAYS = '-3';
  assert.strictEqual(lib.pruneDebugDir(), 0, 'negative falls back to 7');
  assert.strictEqual(fs.existsSync(f), true);
  process.env.DEBUG_RETENTION_DAYS = '1';
  assert.strictEqual(lib.pruneDebugDir(), 1, '2-day-old file deleted at 1 day retention');
  assert.strictEqual(fs.existsSync(f), false);
});

test('subdirectories and paths outside the debug dir are untouched', () => {
  reset();
  const sub = path.join(debugDir, 'old-sub');
  const inSub = put(path.join(sub, 'deep.png'), 30);
  fs.utimesSync(sub, (Date.now() - 30 * DAY) / 1000, (Date.now() - 30 * DAY) / 1000);
  const oldDebug = dbg('x.html', 30);
  const outside = put(path.join(tmp, 'outside.txt'), 30);
  const sess = put(path.join(tmp, 'sessions', 'amazon-session.json'), 30);
  const n = lib.pruneDebugDir();
  assert.strictEqual(n, 1, 'only the one old regular file directly in debug/');
  assert.strictEqual(fs.existsSync(oldDebug), false);
  assert.strictEqual(fs.existsSync(sub), true, 'old subdirectory kept');
  assert.strictEqual(fs.existsSync(inSub), true, 'file inside subdirectory kept');
  assert.strictEqual(fs.existsSync(outside), true, 'file in DATA_DIR kept');
  assert.strictEqual(fs.existsSync(sess), true, 'file in DATA_DIR/sessions kept');
});

test('captureFailure prunes old artifacts (also when the screenshot fails) and keeps the new ones', async () => {
  reset();
  const stale = dbg('amazon-sync-failed-stale.png', 10);
  const page = {
    screenshot: async ({ path: p }) => fs.writeFileSync(p, 'png'),
    content: async () => '<html>ok</html>',
  };
  const out = await lib.captureFailure(page, 'amazon', 'sync-failed');
  assert.strictEqual(fs.existsSync(stale), false, 'pre-existing 10-day-old file pruned');
  assert.ok(out.screenshot && fs.existsSync(out.screenshot), 'new screenshot survives');
  assert.ok(out.html && fs.existsSync(out.html), 'new html survives');
  const stale2 = dbg('amazon-sync-failed-stale2.html', 10);
  const out2 = await lib.captureFailure({ screenshot: async () => { throw new Error('boom'); }, content: async () => '<html/>' }, 'amazon', 'sync-failed');
  assert.strictEqual(out2.screenshot, null);
  assert.strictEqual(fs.existsSync(stale2), false, 'prune ran despite capture failure');
  assert.ok(out2.html && fs.existsSync(out2.html));
});

test('loading lib.js (sidecar startup) prunes the debug dir once', () => {
  reset();
  const stale = dbg('amazon-login-open-startup.html', 12);
  const fresh = dbg('amazon-login-open-fresh.html', 1);
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath, ['-e', "try{require.resolve('playwright-core')}catch(e){const M=require('module');const o=M._load;M._load=function(q,...a){return q==='playwright-core'?{chromium:{}}:o.call(this,q,...a)}};require('./src/lib')"], {
    cwd: __dirname, env: { ...process.env, DATA_DIR: tmp }, encoding: 'utf8',
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(fs.existsSync(stale), false, '12-day-old file pruned at startup');
  assert.strictEqual(fs.existsSync(fresh), true, '1-day-old file kept at startup');
});
