'use strict';
// Regression tests for sidecar/src/loginCooldown.js (per-site login throttle
// cooldown, idle-timeout backoff, preempt request/cooldown). Persisted on DATA_DIR.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-cooldown-'));
process.env.DATA_DIR = tmp;
delete process.env.LOGIN_THROTTLE_COOLDOWN_MIN;
delete process.env.LOGIN_THROTTLE_MAX_COOLDOWN_MIN;
delete process.env.LOGIN_PREEMPT_COOLDOWN_MIN;

const cd = require('./src/loginCooldown');
const MIN = 60 * 1000;
const T0 = 1_800_000_000_000;

function freshModule() {
  delete require.cache[require.resolve('./src/loginCooldown')];
  return require('./src/loginCooldown');
}

// nothing recorded -> no cooldown
assert.strictEqual(cd.getCooldown('costco', T0), null, 'no cooldown initially');

// first 429: 45 minutes
const e1 = cd.recordThrottle('costco', { now: T0, status: 429 });
assert.strictEqual(e1.until, T0 + 45 * MIN, 'first throttle = 45 min');
const g1 = cd.getCooldown('costco', T0 + 1000);
assert.ok(g1 && g1.until === T0 + 45 * MIN, 'cooldown active');
assert.ok(/costco throttled by sign-in service \(429\), retry after \d\d:\d\d/.test(g1.message), 'message: ' + g1.message);
assert.strictEqual(cd.getCooldown('amazon', T0 + 1000), null, 'other sites unaffected');

// persisted: file on DATA_DIR and survives a module reload
assert.ok(fs.existsSync(path.join(tmp, 'login-cooldown.json')), 'persisted at DATA_DIR/login-cooldown.json');
const cd2 = freshModule();
const g2 = cd2.getCooldown('costco', T0 + 1000);
assert.ok(g2 && g2.until === T0 + 45 * MIN, 'cooldown survives reload');

// expiry
assert.strictEqual(cd2.getCooldown('costco', T0 + 45 * MIN), null, 'expired exactly at until');
assert.strictEqual(cd2.getCooldown('costco', T0 + 46 * MIN), null, 'expired later');

// doubling: 45, 90, 180, then capped at 240
const e2 = cd2.recordThrottle('costco', { now: T0 + 46 * MIN, status: 429 });
assert.strictEqual(e2.until - (T0 + 46 * MIN), 90 * MIN, 'second = 90 min');
const e3 = cd2.recordThrottle('costco', { now: T0 + 200 * MIN, status: 429 });
assert.strictEqual(e3.until - (T0 + 200 * MIN), 180 * MIN, 'third = 180 min');
const e4 = cd2.recordThrottle('costco', { now: T0 + 400 * MIN, status: 429 });
assert.strictEqual(e4.until - (T0 + 400 * MIN), 240 * MIN, 'fourth capped at 240 min');
const e5 = cd2.recordThrottle('costco', { now: T0 + 700 * MIN, status: 429 });
assert.strictEqual(e5.until - (T0 + 700 * MIN), 240 * MIN, 'stays capped');

// cleared on success
cd2.clearCooldown('costco');
assert.strictEqual(cd2.getCooldown('costco', T0 + 701 * MIN), null, 'cleared');
const e6 = cd2.recordThrottle('costco', { now: T0 + 800 * MIN, status: 429 });
assert.strictEqual(e6.until - (T0 + 800 * MIN), 45 * MIN, 'doubling restarts after clear');
assert.ok(!JSON.stringify(JSON.parse(fs.readFileSync(path.join(tmp, 'login-cooldown.json'), 'utf8'))).includes('"count":5'), 'count reset');
cd2.clearCooldown('costco');

// env configuration
process.env.LOGIN_THROTTLE_COOLDOWN_MIN = '10';
process.env.LOGIN_THROTTLE_MAX_COOLDOWN_MIN = '25';
const e7 = cd2.recordThrottle('walmart', { now: T0, status: 429 });
assert.strictEqual(e7.until - T0, 10 * MIN, 'env base');
const e8 = cd2.recordThrottle('walmart', { now: T0 + 11 * MIN, status: 429 });
assert.strictEqual(e8.until - (T0 + 11 * MIN), 20 * MIN, 'env doubled');
const e9 = cd2.recordThrottle('walmart', { now: T0 + 40 * MIN, status: 429 });
assert.strictEqual(e9.until - (T0 + 40 * MIN), 25 * MIN, 'env cap');
cd2.clearCooldown('walmart');
delete process.env.LOGIN_THROTTLE_COOLDOWN_MIN;
delete process.env.LOGIN_THROTTLE_MAX_COOLDOWN_MIN;

// idle (no human activity) timeouts: 2 consecutive -> cooldown
assert.strictEqual(cd2.recordIdleTimeout('costco', { now: T0 }), null, 'first idle timeout: no cooldown yet');
assert.strictEqual(cd2.getCooldown('costco', T0 + 1), null);
const cd3 = freshModule(); // counter persisted too
const idle2 = cd3.recordIdleTimeout('costco', { now: T0 + 10 * MIN });
assert.ok(idle2 && idle2.until === T0 + 10 * MIN + 45 * MIN, 'second consecutive idle timeout -> 45 min cooldown');
const gi = cd3.getCooldown('costco', T0 + 11 * MIN);
assert.ok(gi && /costco/.test(gi.message) && /retry after \d\d:\d\d/.test(gi.message), 'idle message: ' + (gi && gi.message));
cd3.clearCooldown('costco');

// activity resets the idle counter
cd3.recordIdleTimeout('costco', { now: T0 });
cd3.recordActiveTimeout('costco');
assert.strictEqual(cd3.recordIdleTimeout('costco', { now: T0 + MIN }), null, 'counter was reset by an active timeout');
cd3.clearCooldown('costco');

// preempt: request file semantics
assert.strictEqual(cd3.isPreemptRequested('costco', T0), false);
cd3.requestPreempt('costco', { now: T0 });
assert.ok(fs.existsSync(path.join(tmp, 'login-preempt-costco.json')), 'request file on DATA_DIR');
assert.strictEqual(cd3.isPreemptRequested('costco', T0 + 30 * 1000), true, 'fresh request visible');
assert.strictEqual(cd3.isPreemptRequested('amazon', T0 + 30 * 1000), false, 'per-site');
assert.strictEqual(cd3.isPreemptRequested('costco', T0 + 61 * 1000), false, 'request older than 60s is stale');
cd3.requestPreempt('costco', { now: T0 });
cd3.clearPreemptRequest('costco');
assert.strictEqual(cd3.isPreemptRequested('costco', T0 + 1000), false, 'cleared request');


// idle backoff also doubles (45 -> 90 -> 180 -> 240 cap) and keeps counting after expiry
cd3.clearCooldown('costco');
assert.strictEqual(cd3.recordIdleTimeout('costco', { now: T0 }), null);
assert.strictEqual(cd3.recordIdleTimeout('costco', { now: T0 + MIN }).until, T0 + MIN + 45 * MIN, 'idle#2 = 45');
assert.strictEqual(cd3.recordIdleTimeout('costco', { now: T0 + 100 * MIN }).until, T0 + 100 * MIN + 90 * MIN, 'idle#3 = 90');
assert.strictEqual(cd3.recordIdleTimeout('costco', { now: T0 + 300 * MIN }).until, T0 + 300 * MIN + 180 * MIN, 'idle#4 = 180');
cd3.clearCooldown('costco');

// preempt requests are independent of the cooldown state file (different processes write them)
cd3.clearPreemptRequest('costco');
try { fs.unlinkSync(path.join(tmp, 'login-cooldown.json')); } catch {}
cd3.requestPreempt('costco', { now: T0 });
assert.ok(!fs.existsSync(path.join(tmp, 'login-cooldown.json')), 'requestPreempt must not write the cooldown state file');
cd3.clearCooldown('costco');
assert.strictEqual(cd3.isPreemptRequested('costco', T0 + 1000), true, 'clearCooldown must not cancel a pending preempt request');
cd3.clearPreemptRequest('costco');
cd3.recordThrottle('costco', { now: T0, status: 429 });
cd3.clearPreemptRequest('costco');
assert.ok(cd3.getCooldown('costco', T0 + 1000), 'clearPreemptRequest must not touch cooldown state');
cd3.clearCooldown('costco');


// HH:MM in messages is the zero-padded LOCAL time of `until`
for (const [h, m] of [[7, 3], [14, 9], [0, 0], [23, 59], [10, 10]]) {
  const until = new Date(2027, 0, 5, h, m).getTime();
  const hh = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  cd3.clearCooldown('costco');
  cd3.recordThrottle('costco', { now: until - 45 * MIN, status: 429 });
  assert.ok(cd3.getCooldown('costco', until - MIN).message.endsWith('retry after ' + hh), 'throttle HH:MM ' + hh + ': ' + cd3.getCooldown('costco', until - MIN).message);
  cd3.clearCooldown('costco');
  cd3.recordPreempt('costco', { now: until - 5 * MIN });
  assert.ok(cd3.getCooldown('costco', until - MIN).message.endsWith('retry after ' + hh), 'preempt HH:MM ' + hh);
  cd3.clearCooldown('costco');
  cd3.recordIdleTimeout('costco', { now: until - 45 * MIN - 1 });
  cd3.recordIdleTimeout('costco', { now: until - 45 * MIN });
  const gm = cd3.getCooldown('costco', until - MIN);
  assert.ok(gm.message.endsWith('retry after ' + hh) && /no activity/.test(gm.message) && gm.reason === 'idle', 'idle msg ' + gm.message);
  cd3.clearCooldown('costco');
}
// a stale idle reason must not mislabel a later real 429, and getCooldown never throws for odd args
cd3.recordIdleTimeout('costco', { now: T0 }); cd3.recordIdleTimeout('costco', { now: T0 });
cd3.recordThrottle('costco', { now: T0 + 1, status: 429 });
assert.ok(/throttled by sign-in service \(429\)/.test(cd3.getCooldown('costco', T0 + 2).message), 'recordThrottle after idle relabels as throttle');
assert.strictEqual(cd3.getCooldown('costco', T0 + 2).reason, 'throttle');
cd3.clearCooldown('costco');


// appliesTo: which sites get throttle/idle backoff (default costco only; Amazon untouched)
delete process.env.LOGIN_COOLDOWN_SITES;
assert.strictEqual(cd3.appliesTo('costco'), true);
assert.strictEqual(cd3.appliesTo('amazon'), false, 'amazon never backs off by default');
assert.strictEqual(cd3.appliesTo('walmart'), false);
process.env.LOGIN_COOLDOWN_SITES = 'costco, walmart';
assert.strictEqual(cd3.appliesTo('walmart'), true, 'env list, trimmed');
assert.strictEqual(cd3.appliesTo('amazon'), false);
process.env.LOGIN_COOLDOWN_SITES = '';
assert.strictEqual(cd3.appliesTo('costco'), true, 'empty env falls back to default');
assert.strictEqual(cd3.appliesTo('amazon'), false);
delete process.env.LOGIN_COOLDOWN_SITES;

// preempt cooldown: 5 minutes, then expires; does not double throttle count
const p = cd3.recordPreempt('costco', { now: T0 });
assert.strictEqual(p.until, T0 + 5 * MIN, 'preempt cooldown 5 min');
const gp = cd3.getCooldown('costco', T0 + 4 * MIN);
assert.ok(gp && gp.until === T0 + 5 * MIN, 'preempt cooldown blocks');
assert.strictEqual(cd3.getCooldown('costco', T0 + 5 * MIN), null, 'preempt cooldown expires');
// longest wins when throttle also active
cd3.recordThrottle('costco', { now: T0, status: 429 });
cd3.recordPreempt('costco', { now: T0 });
assert.strictEqual(cd3.getCooldown('costco', T0 + 6 * MIN).until, T0 + 45 * MIN, 'longest cooldown wins');
cd3.clearCooldown('costco');

// corrupt file tolerated
fs.writeFileSync(path.join(tmp, 'login-cooldown.json'), '{not json');
assert.strictEqual(freshModule().getCooldown('costco', T0), null, 'corrupt state file ignored');

console.log('test-login-cooldown: ok');
