'use strict';
// Regression test: launchBrowser passes ignoreDefaultArgs ['--enable-automation']
// and keeps its other flags (headless:false, executablePath, --no-sandbox etc).

const assert = require('assert');
process.env.TRACKER_URL = process.env.TRACKER_URL || 'http://127.0.0.1:9';
process.env.TRACKER_USER_ID = process.env.TRACKER_USER_ID || '1';
process.env.DATA_DIR = process.env.DATA_DIR || require('os').tmpdir();

const pw = require('playwright-core');
let seen = null;
pw.chromium.launch = async opts => { seen = opts; return { fake: true }; };
const lib = require('./src/lib');

(async () => {
  const b = await lib.launchBrowser();
  assert(b && b.fake, 'launchBrowser returns what chromium.launch returned');
  assert(seen, 'chromium.launch was called');
  assert.strictEqual(seen.headless, false, 'still headed (Xvfb)');
  assert(Array.isArray(seen.ignoreDefaultArgs) && seen.ignoreDefaultArgs.includes('--enable-automation'), 'ignoreDefaultArgs must include --enable-automation, got ' + JSON.stringify(seen.ignoreDefaultArgs));
  assert.strictEqual(seen.ignoreDefaultArgs.length, 1, 'only --enable-automation is ignored (do not disable other Playwright defaults)');
  for (const a of ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled', '--window-size=1280,900']) {
    assert(seen.args.includes(a), 'existing flag kept: ' + a);
  }
  assert.strictEqual(seen.executablePath, process.env.CHROME_PATH || '/usr/bin/google-chrome-stable', 'executablePath unchanged');
  console.log('test-launch-flags: ok');
})().catch(e => { console.error(e); process.exit(1); });
