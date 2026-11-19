'use strict';
// The sidecar claims only the Walmart, Costco, CBM and MGCP command types.
// Amazon is the browser extension's alone: every Amazon type stays pending
// for it, whatever env flags are set.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-handles-'));
process.env.TRACKER_URL = 'http://127.0.0.1:9';
process.env.TRACKER_USER_ID = '1';

const { sidecarHandles, SITES } = require('./src/poll');

assert.strictEqual(typeof sidecarHandles, 'function');
for (const type of ['SYNC_AMAZON', 'SYNC_AMAZON_ORDER', 'SYNC_AMAZON_PAGES', 'TRACK_AMAZON', 'NOT_A_COMMAND']) {
  assert.strictEqual(sidecarHandles(type), false, type);
}
for (const type of ['SYNC_WALMART', 'SYNC_COSTCO', 'SYNC_COSTCO_ORDER', 'SCRAPE_CBM', 'SCRAPE_MGCP']) {
  assert.strictEqual(sidecarHandles(type), true, type);
}
for (const [type, def] of Object.entries(SITES)) {
  assert.notStrictEqual(def.site, 'amazon', type);
  assert.strictEqual(sidecarHandles(type), true, type);
}
console.log('test-sidecar-handles: ok');
