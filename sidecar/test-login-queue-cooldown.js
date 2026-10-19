'use strict';
// Regression: the always-on login queue must not reopen a site's window while
// the site is in cooldown (429 throttle / repeated idle timeouts / preemption),
// and must record/clear cooldown state from the waitForLogin outcome.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-lq-'));
process.env.DATA_DIR = tmp;
process.env.SIDECAR_COSTCO_ENABLED = '1'; // kill switch off: this suite tests costco paths
process.env.TRACKER_URL = 'http://127.0.0.1:9';
process.env.TRACKER_USER_ID = '1';

const lib = require('./src/lib');
const acquired = [];
lib.getSettings = async () => ({});
lib.setSettings = async () => {};
const reported = [];
lib.logApiError = async (e) => { reported.push(e); };
lib.hasSession = () => false; // every site "needs login"
lib.launchBrowser = async () => ({
  newContext: async () => ({ newPage: async () => ({}), addInitScript: async () => {}, close: async () => {} }),
  close: async () => {},
});
lib.acquireBrowserLock = async (kind, { site } = {}) => { acquired.push(site); return async () => {}; };

const loginFlow = require('./src/loginFlow');
for (const s of Object.keys(loginFlow.SITE_CONFIG)) loginFlow.SITE_CONFIG[s].prepareContext = undefined;
let behavior = {}; // site -> (opts) => boolean
loginFlow.waitForLogin = async (site, page, opts = {}) => {
  const f = behavior[site];
  return f ? f(opts) : false;
};

const cd = require('./src/loginCooldown');
const queue = require('./src/loginQueue');
const MIN = 60 * 1000;
const SITES = ['amazon', 'walmart', 'costco', 'bfmr'];

async function cycle() { acquired.length = 0; await queue.runQueueOnce(); return [...acquired]; }
function reset() { for (const s of SITES) { cd.clearCooldown(s); cd.clearPreemptRequest(s); } behavior = {}; }
const idle = opts => { if (opts.outcome) { opts.outcome.reason = 'timeout'; opts.outcome.hadActivity = false; } return false; };
const active = opts => { if (opts.outcome) { opts.outcome.reason = 'timeout'; opts.outcome.hadActivity = true; } return false; };

(async () => {
  // 1. baseline: all sites opened
  reset();
  let got = await cycle();
  for (const s of SITES) assert(got.includes(s), 'baseline opens ' + s + ': ' + got);

  // 2. a recorded 429 throttle blocks costco only; other sites (Amazon) unchanged
  reset();
  cd.recordThrottle('costco', { status: 429 });
  got = await cycle();
  assert(!got.includes('costco'), 'costco in cooldown must not be reopened: ' + got);
  for (const s of ['amazon', 'walmart', 'bfmr']) assert(got.includes(s), s + ' unaffected: ' + got);

  // 3. cooldown expiry reopens it
  reset();
  cd.recordThrottle('costco', { status: 429, now: Date.now() - 100 * MIN }); // expired 55 min ago
  got = await cycle();
  assert(got.includes('costco'), 'expired cooldown reopens: ' + got);

  // 4. two consecutive no-activity timeouts -> backoff, third cycle does not reopen
  reset();
  behavior.costco = idle;
  got = await cycle(); assert(got.includes('costco'), 'cycle 1 opens');
  reported.length = 0;
  got = await cycle(); assert(got.includes('costco'), 'cycle 2 opens');
  assert(cd.getCooldown('costco'), 'cooldown set after 2 idle timeouts');
  assert.strictEqual(reported.length, 1, 'cooldown start is reported once to the tracker: ' + JSON.stringify(reported));
  assert(/costco/.test(reported[0].context) && /retry after \d\d:\d\d/.test(reported[0].context), reported[0].context);
  got = await cycle(); assert(!got.includes('costco'), 'cycle 3 must not reopen: ' + got);
  assert.strictEqual(reported.length, 1, 'no repeat report while in cooldown');
  assert(got.includes('amazon'), 'amazon still opens');

  // 5. a timeout WITH human activity resets the idle counter (no backoff)
  reset();
  behavior.costco = idle; await cycle();
  behavior.costco = active; await cycle();
  behavior.costco = idle; await cycle();
  assert.strictEqual(cd.getCooldown('costco'), null, 'activity resets counter -> no cooldown');
  got = await cycle(); assert(got.includes('costco'));

  // 6. preempted outcome does not count as an idle timeout
  reset();
  behavior.costco = o => { if (o.outcome) { o.outcome.reason = 'preempted'; o.outcome.hadActivity = false; } return false; };
  await cycle(); await cycle(); await cycle();
  assert.strictEqual(cd.getCooldown('costco'), null, 'preempted close is not an idle timeout');

  // 7. success clears cooldown state (incl. persisted idle counter / throttle count)
  reset();
  cd.recordThrottle('costco', { status: 429, now: Date.now() - 500 * MIN }); // expired
  cd.recordIdleTimeout('costco');
  behavior.costco = () => true;
  got = await cycle(); assert(got.includes('costco'));
  const state = JSON.parse(fs.readFileSync(path.join(tmp, 'login-cooldown.json'), 'utf8'));
  assert(!state.costco, 'success clears costco state: ' + JSON.stringify(state));

  // 8. a fresh preempt request (a sync is waiting) blocks reopening
  reset();
  cd.requestPreempt('costco');
  got = await cycle(); assert(!got.includes('costco'), 'pending preempt request blocks reopen: ' + got);

  // 9. preemption cooldown (5 min) blocks reopen
  reset();
  cd.recordPreempt('costco');
  got = await cycle(); assert(!got.includes('costco'), 'post-preempt cooldown blocks reopen: ' + got);

  // 10. a throttle recorded by loginFlow DURING the window (429) is reported to the tracker once
  reset();
  reported.length = 0;
  behavior.costco = o => { cd.recordThrottle('costco', { status: 429 }); o.outcome.reason = 'timeout'; o.outcome.hadActivity = true; return false; };
  await cycle();
  assert.strictEqual(reported.length, 1, '429 recorded during the window is reported once: ' + JSON.stringify(reported));
  assert(/429/.test(reported[0].context), reported[0].context);
  await cycle(); // in cooldown now: skipped, no repeat report
  assert.strictEqual(reported.length, 1, 'no repeat report');

  // 11. Amazon (and other non-cooldown sites) never back off on repeated idle timeouts: byte-identical to today
  reset();
  behavior.amazon = idle; behavior.walmart = idle;
  for (let i = 0; i < 5; i++) { got = await cycle(); assert(got.includes('amazon') && got.includes('walmart'), 'amazon/walmart reopened on cycle ' + i + ': ' + got); }
  assert.strictEqual(cd.getCooldown('amazon'), null, 'no amazon cooldown');
  assert.strictEqual(cd.getCooldown('walmart'), null, 'no walmart cooldown by default');
  // ... but LOGIN_COOLDOWN_SITES can opt a site in
  process.env.LOGIN_COOLDOWN_SITES = 'costco,walmart';
  await cycle(); await cycle();
  assert(cd.getCooldown('walmart'), 'walmart opted in -> backs off after 2 idle timeouts');
  assert.strictEqual(cd.getCooldown('amazon'), null, 'amazon still never');
  delete process.env.LOGIN_COOLDOWN_SITES;
  // costco cooling down does not stop amazon
  reset();
  cd.recordThrottle('costco', { status: 429 });
  got = await cycle(); assert(got.includes('amazon') && !got.includes('costco'), 'amazon opens while costco cools: ' + got);

  console.log('test-login-queue-cooldown: ok');
})().catch(e => { console.error(e); process.exit(1); }).finally(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });
