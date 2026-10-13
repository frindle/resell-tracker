'use strict';
// Regression: waitForLogin (a) records a persisted cooldown on HTTP 429 (or 403 on a
// credential POST) seen on any page response, (b) reports an outcome object, and
// (c) closes an idle window when a sync requested preemption, but never an active one.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-ltp-'));
process.env.DATA_DIR = tmp;
process.env.TRACKER_URL = 'http://127.0.0.1:9';
process.env.TRACKER_USER_ID = '1';

const lib = require('./src/lib');
lib.setSettings = async () => {};
lib.captureFailure = async () => ({});
const loginFlow = require('./src/loginFlow');
const cd = require('./src/loginCooldown');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MIN = 60 * 1000;

let loggedIn = false;
loginFlow.SITE_CONFIG.costco.isLoggedOut = p => /signin/.test(p.url());
loginFlow.SITE_CONFIG.costco.confirmLoggedIn = async () => loggedIn;
loginFlow.SITE_CONFIG.costco.nudge = undefined;
loginFlow.SITE_CONFIG.amazon.isLoggedOut = p => /signin|\/ap\//.test(p.url());
loginFlow.SITE_CONFIG.amazon.confirmLoggedIn = async () => loggedIn;
loginFlow.SITE_CONFIG.amazon.nudge = undefined;

function mk() {
  const handlers = {};
  const page = {
    _url: 'https://signin.costco.com/signin', _title: 'Sign In',
    isClosed: () => false, url: () => page._url, title: async () => page._title,
    goto: async () => {}, evaluate: async () => undefined,
    screenshot: async () => {}, content: async () => '',
    on(ev, h) { (handlers[ev] = handlers[ev] || []).push(h); }, off() {},
  };
  const ctx = {
    pages: () => [page], on() {}, off() {}, addInitScript: async () => {},
    storageState: async ({ path: p } = {}) => { if (p) fs.writeFileSync(p, '{}'); return {}; },
  };
  const emit = (status, method, url) => {
    const res = {
      status: () => status, url: () => url, ok: () => status < 400, statusText: () => '',
      headers: () => ({}), request: () => ({ method: () => method, url: () => url, headers: () => ({}) }),
    };
    for (const h of handlers.response || []) { try { h(res); } catch { /* other listeners may choke on the fake */ } }
  };
  return { page, ctx, emit };
}
const OPTS = { timeoutMs: 400, pollMs: 50, activityWindowMs: 300, hardMaxMs: 2500 };
function reset() { cd.clearCooldown('costco'); cd.clearPreemptRequest('costco'); loggedIn = false; }
async function run(setup, extra = {}, site = 'costco') {
  const { page, ctx, emit } = mk();
  const outcome = {};
  const t0 = Date.now();
  const stopper = setup ? setup(page, emit) : null;
  const ok = await loginFlow.waitForLogin(site, page, { ...OPTS, ...extra, context: ctx, outcome });
  if (stopper) stopper();
  return { ok, ms: Date.now() - t0, outcome };
}
const SA = 'https://signin.costco.com/x/B2C_1A_SSO_WCS_signup_signin_214/SelfAsserted?tx=1';

(async () => {
  // A. 429 on the credential POST -> persisted 45 min cooldown, message mentions 429
  reset();
  let r = await run((p, emit) => { setTimeout(() => emit(429, 'POST', SA), 100); });
  let g = cd.getCooldown('costco');
  assert(g, '429 must set a cooldown');
  assert(Math.abs(g.until - (Date.now() + 45 * MIN)) < 30 * 1000, '45 min cooldown, until-now=' + (g.until - Date.now()));
  assert(/429/.test(g.message), g.message);
  assert(fs.existsSync(path.join(tmp, 'login-cooldown.json')), 'persisted');
  assert.strictEqual(r.outcome.reason, 'timeout');

  // B. repeated 429 inside one window records ONE throttle (no runaway doubling)
  reset();
  await run((p, emit) => { for (const t of [60, 120, 180]) setTimeout(() => emit(429, 'POST', SA), t); });
  g = cd.getCooldown('costco');
  assert(g && Math.abs(g.until - (Date.now() + 45 * MIN)) < 30 * 1000, 'one throttle per window');

  // C. 429 on any page response (not only POST)
  reset();
  await run((p, emit) => { setTimeout(() => emit(429, 'GET', 'https://signin.costco.com/authorize'), 100); });
  assert(cd.getCooldown('costco'), '429 on GET sets cooldown');

  // D. 403 on the credential POST throttles; 403 on a GET / 200 on POST do not
  reset();
  await run((p, emit) => { setTimeout(() => emit(403, 'POST', SA), 100); });
  assert(cd.getCooldown('costco'), '403 on credential POST sets cooldown');
  reset();
  await run((p, emit) => { setTimeout(() => { emit(403, 'GET', 'https://www.costco.com/x.js'); emit(403, 'GET', SA); emit(200, 'POST', SA); emit(404, 'GET', SA); }, 100); });
  assert.strictEqual(cd.getCooldown('costco'), null, 'non-throttle responses do not set cooldown');

  // E. outcome: idle timeout vs activity vs success
  reset();
  r = await run();
  assert.deepStrictEqual([r.ok, r.outcome.reason, r.outcome.hadActivity], [false, 'timeout', false], JSON.stringify(r.outcome));
  r = await run(p => { let n = 0; const h = setInterval(() => { p._url = 'https://signin.costco.com/signin?s=' + (++n); }, 100); return () => clearInterval(h); });
  assert.deepStrictEqual([r.ok, r.outcome.reason, r.outcome.hadActivity], [false, 'timeout', true], JSON.stringify(r.outcome));
  r = await run(p => { setTimeout(() => { loggedIn = true; p._url = 'https://www.costco.com/myaccount'; }, 120); });
  assert.deepStrictEqual([r.ok, r.outcome.reason], [true, 'success'], JSON.stringify(r.outcome));

  // F. idle window + preempt request -> closed early as 'preempted', request cleared, 5 min cooldown
  reset();
  cd.requestPreempt('costco');
  r = await run(null, { timeoutMs: 5000 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.outcome.reason, 'preempted', JSON.stringify(r.outcome));
  assert(r.ms < 2000, 'idle window preempted promptly, took ' + r.ms);
  assert.strictEqual(cd.isPreemptRequested('costco'), false, 'request consumed');
  g = cd.getCooldown('costco');
  assert(g && g.until - Date.now() > 4 * MIN && g.until - Date.now() <= 5 * MIN + 1000, 'post-preempt cooldown ~5min');

  // G. window with recent human activity is NOT preempted while active
  reset();
  r = await run((p, emit) => {
    let n = 0; const start = Date.now();
    const h = setInterval(() => { if (Date.now() - start < 1200) p._url = 'https://signin.costco.com/signin?s=' + (++n); else clearInterval(h); }, 100);
    setTimeout(() => cd.requestPreempt('costco'), 200);
    return () => clearInterval(h);
  }, { timeoutMs: 5000 });
  assert(r.ms >= 1200, 'active window must not be preempted while the human is active, took ' + r.ms);

  // H. stale (>60s old) preempt request is ignored
  reset();
  cd.requestPreempt('costco', { now: Date.now() - 120 * 1000 });
  r = await run();
  assert.strictEqual(r.outcome.reason, 'timeout');

  // I. Amazon is never throttle-recorded (Amazon behavior unchanged), but an idle Amazon window IS preemptable
  cd.clearCooldown('amazon');
  r = await run((p, emit) => { setTimeout(() => emit(429, 'POST', 'https://www.amazon.com/ap/signin'), 100); }, {}, 'amazon');
  assert.strictEqual(cd.getCooldown('amazon'), null, '429 on amazon does not set a cooldown');
  assert.strictEqual(r.outcome.reason, 'timeout');
  cd.requestPreempt('amazon');
  r = await run(null, { timeoutMs: 5000 }, 'amazon');
  assert.strictEqual(r.outcome.reason, 'preempted', 'idle amazon window preempted too');
  cd.clearCooldown('amazon'); cd.clearPreemptRequest('amazon');

  // J. same, but the human is still active when the main window timeout passes (extension loop): never preempted while active
  reset();
  r = await run((p) => {
    let n = 0; const start = Date.now();
    const h = setInterval(() => { if (Date.now() - start < 1500) p._url = 'https://signin.costco.com/signin?s=' + (++n); else clearInterval(h); }, 100);
    setTimeout(() => cd.requestPreempt('costco'), 700);
    return () => clearInterval(h);
  });
  assert(r.ms >= 1500, 'extension-loop: active window must not be preempted, took ' + r.ms);
  assert(r.ms <= 2800, 'extension-loop: ends once idle, took ' + r.ms);

  console.log('test-login-throttle-preempt: ok');
})().catch(e => { console.error(e); process.exit(1); }).finally(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });
