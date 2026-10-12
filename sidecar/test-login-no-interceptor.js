'use strict';
// Regression test: the Costco fetch/XHR interceptor must NOT be injected into the
// login window (it runs on signin.costco.com); it is still installed by poll.js
// for real syncs.

const assert = require('assert');
const fs = require('fs');
process.env.TRACKER_URL = process.env.TRACKER_URL || 'http://127.0.0.1:9';
process.env.TRACKER_USER_ID = process.env.TRACKER_USER_ID || '1';
process.env.DATA_DIR = process.env.DATA_DIR || require('os').tmpdir();

const { SITE_CONFIG } = require('./src/loginFlow');
const costco = require('./src/costco');
const bfmr = require('./src/bfmr');

assert(SITE_CONFIG.costco, 'costco config exists');
assert(!SITE_CONFIG.costco.prepareContext, 'costco login window must not install the interceptor');
assert.strictEqual(typeof SITE_CONFIG.costco.confirmLoggedIn, 'function', 'costco confirmLoggedIn kept');
assert.strictEqual(SITE_CONFIG.costco.confirmLoggedIn, costco.confirmLoggedIn, 'costco confirmLoggedIn is still costco.confirmLoggedIn');
assert.strictEqual(SITE_CONFIG.costco.isLoggedOut, costco.isLoggedOut, 'costco isLoggedOut unchanged');
assert.strictEqual(SITE_CONFIG.costco.url, costco.ORDERS_URL, 'costco url unchanged');
// other sites untouched
assert.strictEqual(SITE_CONFIG.bfmr.prepareContext, bfmr.installInterceptor, 'bfmr still needs its interceptor to prove login');
assert(!SITE_CONFIG.amazon.prepareContext && !SITE_CONFIG.walmart.prepareContext, 'amazon/walmart unchanged');
// the sync path still installs the Costco interceptor (poll.js SITES.SYNC_COSTCO.prepareContext)
const polltxt = fs.readFileSync(require('path').join(__dirname, 'src', 'poll.js'), 'utf8');
assert(/installCostcoInterceptor/.test(polltxt), 'poll.js still wires the costco interceptor for syncs');
assert.strictEqual(typeof costco.installInterceptor, 'function', 'costco.installInterceptor still exported');
console.log('test-login-no-interceptor: ok');
