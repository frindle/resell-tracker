'use strict';
// The sidecar skips Amazon commands unless SIDECAR_AMAZON_ENABLED=1;
// Walmart and Costco commands are unaffected.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-handles-'));
process.env.TRACKER_URL = 'http://127.0.0.1:9';
process.env.TRACKER_USER_ID = '1';

const { sidecarHandles, SITES } = require('./src/poll');

assert.strictEqual(typeof sidecarHandles, 'function');
delete process.env.SIDECAR_AMAZON_ENABLED;
assert.strictEqual(sidecarHandles('SYNC_AMAZON'), false);
assert.strictEqual(sidecarHandles('SYNC_AMAZON_ORDER'), false);
assert.strictEqual(sidecarHandles('SYNC_AMAZON_PAGES'), false, 'extension command, never the sidecar');
assert.strictEqual(sidecarHandles('NOT_A_COMMAND'), false);
for (const [type, def] of Object.entries(SITES)) {
  if (def.site !== 'amazon') assert.strictEqual(sidecarHandles(type), true, type);
}
process.env.SIDECAR_AMAZON_ENABLED = '1';
assert.strictEqual(sidecarHandles('SYNC_AMAZON'), true);
assert.strictEqual(sidecarHandles('SYNC_AMAZON_PAGES'), false);
console.log('test-sidecar-handles: ok');
