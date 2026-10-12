'use strict';
// Regression test for the waitForLogin activity-window extension in sidecar/src/loginFlow.js
// waitForLogin must not give up while a human is still navigating; bounded by a hard max.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-lf-'));
process.env.DATA_DIR = tmp;
process.env.TRACKER_URL = 'http://127.0.0.1:9';
process.env.TRACKER_USER_ID = '1';

const lib = require('./src/lib');
const captured = [];
lib.setSettings = async () => {};
lib.captureFailure = async (page, site, label) => { captured.push({ site, label }); return {}; };
const loginFlow = require('./src/loginFlow');

const sleep = ms => new Promise(r => setTimeout(r, ms));
let loggedIn = false;
loginFlow.SITE_CONFIG.amazon.isLoggedOut = p => /\/ap\//.test(p.url());
loginFlow.SITE_CONFIG.amazon.confirmLoggedIn = async () => loggedIn;

function mk() {
  const page = {
    _url: 'https://www.amazon.com/ap/signin', _title: 'Sign in',
    isClosed: () => false, url: () => page._url, title: async () => page._title,
    goto: async () => {}, on() {}, off() {}, evaluate: async () => undefined,
    screenshot: async () => {}, content: async () => '',
  };
  const ctx = {
    pages: () => [page], on() {}, off() {}, addInitScript: async () => {},
    storageState: async ({ path: p } = {}) => { if (p) fs.writeFileSync(p, '{}'); return {}; },
  };
  return { page, ctx };
}
const OPTS = { timeoutMs: 400, pollMs: 50, activityWindowMs: 300, hardMaxMs: 2500 };
async function run(setup) {
  loggedIn = false; captured.length = 0;
  const { page, ctx } = mk();
  const t0 = Date.now();
  const stopper = setup ? setup(page) : null;
  const ok = await loginFlow.waitForLogin('amazon', page, { ...OPTS, context: ctx });
  if (stopper) stopper();
  return { ok, ms: Date.now() - t0, page };
}
const nav = (page, until, every, field = '_url') => {
  let n = 0; const start = Date.now();
  const h = setInterval(() => { if (Date.now() - start < until) page[field] = (field === '_url' ? 'https://www.amazon.com/ap/signin?step=' : 'Step ') + (++n); else clearInterval(h); }, every);
  return () => clearInterval(h);
};

(async () => {
  // A. idle human: gives up at timeoutMs (old behavior preserved)
  let r = await run();
  assert.strictEqual(r.ok, false, 'idle: returns false');
  assert(r.ms >= 350 && r.ms <= 1300, 'idle: ends near timeoutMs, took ' + r.ms);

  // B. URL changes until ~1000ms, then idle: window extended past timeoutMs, ends once activity stops
  r = await run(p => nav(p, 1000, 100));
  assert.strictEqual(r.ok, false, 'active-then-idle: returns false');
  assert(r.ms >= 1000, 'active-then-idle: must NOT time out at timeoutMs while the page is navigating, took ' + r.ms);
  assert(r.ms <= 2400, 'active-then-idle: ends soon after activity stops, took ' + r.ms);

  // B2. title-only changes also count as activity
  r = await run(p => nav(p, 1000, 100, '_title'));
  assert(r.ms >= 1000 && r.ms <= 2400, 'title activity extends the window, took ' + r.ms);

  // C. never-ending activity: hard max bounds it
  r = await run(p => nav(p, 1e9, 100));
  assert.strictEqual(r.ok, false, 'endless activity: false at hard max');
  assert(r.ms >= 2300 && r.ms <= 3800, 'endless activity: stops at hardMaxMs, took ' + r.ms);

  // D. login completes during the extension: returns true and saves the session
  const sess = path.join(tmp, 'sessions', 'amazon-session.json');
  r = await run(p => { const s = nav(p, 600, 100); setTimeout(() => { loggedIn = true; p._url = 'https://www.amazon.com/your-orders/orders'; }, 700); return s; });
  assert.strictEqual(r.ok, true, 'login completing inside the extended window returns true');
  assert(r.ms >= 600 && r.ms <= 1800, 'login detected promptly, took ' + r.ms);
  assert(fs.existsSync(sess), 'session saved');

  // E. login before timeout still works with no activity extension needed
  fs.rmSync(sess, { force: true });
  r = await run(p => { setTimeout(() => { loggedIn = true; p._url = 'https://www.amazon.com/your-orders/orders'; }, 120); return null; });
  assert.strictEqual(r.ok, true, 'plain success still true');

  console.log('test-login-window: ok');
})().catch(e => { console.error(e); process.exit(1); }).finally(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });
