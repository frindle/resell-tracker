'use strict';
// Regression test for login diagnostics (createPageDiagnostics/saveDiagnostics in sidecar/src/lib.js
// and their wiring into waitForLogin). Keeps every assertion and both sections (unit and flow).
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-diag-'));
process.env.DATA_DIR = tmp;
process.env.TRACKER_URL = 'http://127.0.0.1:9';
process.env.TRACKER_USER_ID = '1';
const debugDir = path.join(tmp, 'debug'); // deliberately NOT created: the code must mkdir -p it

const lib = require('./src/lib');
lib.setSettings = async () => {};
const loginFlow = require('./src/loginFlow');
loginFlow.SITE_CONFIG.costco.isLoggedOut = p => /signin\.costco\.com/.test(p.url());
loginFlow.SITE_CONFIG.costco.confirmLoggedIn = async () => false;

function emitter() {
  const h = {};
  return { h, on(evt, fn) { (h[evt] = h[evt] || []).push(fn); }, off() {}, emit(evt, ...a) { for (const f of h[evt] || []) f(...a); } };
}
function mkPage(url) {
  const em = emitter();
  const page = Object.assign(em, {
    _url: url, isClosed: () => false, url: () => page._url, title: async () => 'Sign In',
    goto: async () => {}, evaluate: async () => undefined,
    screenshot: async ({ path: p }) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'png'); },
    content: async () => '<html>x</html>',
  });
  return page;
}
const req = (url, method, errorText) => ({ url: () => url, method: () => method, failure: () => (errorText ? { errorText } : null), headers: () => ({ cookie: 'SECRETCOOKIE' }), postData: () => 'password=SECRETPW' });
const resp = (url, status, method = 'GET') => ({ url: () => url, status: () => status, request: () => req(url, method), headers: () => ({ 'set-cookie': 'SECRETCOOKIE' }) });
const cmsg = (type, text) => ({ type: () => type, text: () => text });

(async () => {
  // ---- unit: createPageDiagnostics collects + sanitizes
  const p0 = mkPage('https://signin.costco.com/b2c?token=SECRETTOKEN#frag');
  const logged = []; const origLog = console.log; console.log = (...a) => { logged.push(a.join(' ')); };
  const d0 = lib.createPageDiagnostics(p0, 'costco');
  p0.emit('framenavigated', { url: () => 'https://signin.costco.com/nav?x=SECRETNAV#h', parentFrame: () => null });
  p0.emit('framenavigated', { url: () => 'https://signin.costco.com/iframe', parentFrame: () => ({}) });
  p0.emit('console', cmsg('error', 'Uncaught TypeError at x Bearer abc.def.ghi and eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abcdefghijklmnop end'));
  p0.emit('console', cmsg('log', 'noise-log-line'));
  p0.emit('pageerror', new Error('page exploded'));
  p0.emit('requestfailed', req('https://signin.costco.com/x?code=SECRETCODE', 'POST', 'net::ERR_BLOCKED_BY_CLIENT'));
  p0.emit('response', resp('https://signin.costco.com/api/login?sid=SECRETSID', 403, 'POST'));
  p0.emit('response', resp('https://signin.costco.com/ok.js', 200));
  for (let i = 0; i < 200; i++) p0.emit('requestfailed', req('https://signin.costco.com/spam' + i, 'GET', 'net::ERR_FAILED'));
  console.log = origLog;
  const s0 = d0.summary();
  const lg = logged.join('\n');
  assert(/\[costco\/page:requestfailed\].*signin\.costco\.com\/x/.test(lg), 'requestfailed logged with [costco/page:requestfailed] prefix: ' + lg.slice(0, 400));
  assert(/\[costco\/page:response\].*403.*\/api\/login/.test(lg), 'http errors logged with [costco/page:response] prefix');
  assert(/\[costco\/page:console\]/.test(lg) && /\[costco\/page:pageerror\]/.test(lg) && /\[costco\/page:nav\].*signin\.costco\.com\/nav/.test(lg), 'console/pageerror/nav logged');
  assert(!/SECRET|abc\.def\.ghi|eyJhbGci/.test(lg), 'logged lines contain no secrets');
  assert.strictEqual(s0.counts.nav, 1, 'only main-frame navigations are counted: ' + JSON.stringify(s0.counts));
  assert(s0.entries.some(e => e.kind === 'nav' && e.url === 'https://signin.costco.com/nav'), 'nav entry recorded with path only');
  assert.strictEqual(s0.site, 'costco');
  assert.strictEqual(s0.url, 'https://signin.costco.com/b2c', 'page url reduced to origin+path');
  assert(Array.isArray(s0.entries) && s0.entries.length <= 50 && s0.entries.length >= 4, 'entries capped at 50, got ' + s0.entries.length);
  assert(s0.counts.requestfailed >= 201 && s0.counts.http_error === 1 && s0.counts.console === 1 && s0.counts.pageerror === 1, 'counts keep totals beyond the cap: ' + JSON.stringify(s0.counts));
  const flat = JSON.stringify(s0);
  for (const bad of ['SECRETTOKEN', 'SECRETCODE', 'SECRETSID', 'SECRETCOOKIE', 'SECRETPW', 'abc.def.ghi', 'eyJhbGciOiJIUzI1NiIs', 'noise-log-line', 'frag']) {
    assert(!flat.includes(bad), 'diagnostics must not contain ' + bad);
  }
  const rf = s0.entries.find(e => e.kind === 'requestfailed' && e.url === 'https://signin.costco.com/x');
  assert(rf && rf.method === 'POST' && /ERR_BLOCKED_BY_CLIENT/.test(rf.error), 'requestfailed entry: ' + JSON.stringify(rf));
  const he = s0.entries.find(e => e.kind === 'http_error');
  assert(he && he.status === 403 && he.url === 'https://signin.costco.com/api/login' && he.method === 'POST', 'http_error entry: ' + JSON.stringify(he));
  assert(s0.entries.some(e => e.kind === 'console' && /TypeError/.test(e.text)), 'console error recorded');
  assert(s0.entries.some(e => e.kind === 'pageerror' && /page exploded/.test(e.text)), 'pageerror recorded');
  assert(!s0.entries.some(e => e.status === 200), 'successful responses are not recorded');

  assert.strictEqual(typeof lib.saveDiagnostics, 'function', 'lib must export saveDiagnostics');
  const saved = await lib.saveDiagnostics(p0, 'costco', 'unit-test', d0);
  assert(fs.existsSync(debugDir), 'debug dir created on demand');
  assert(saved && saved.diag && fs.existsSync(saved.diag) && /costco-unit-test-.*\.diag\.json$/.test(saved.diag), 'saveDiagnostics returns the diag path');
  assert.strictEqual(JSON.parse(fs.readFileSync(saved.diag, 'utf8')).site, 'costco');
  assert(!fs.readFileSync(saved.diag, 'utf8').includes('SECRET'), 'saved file has no secrets');

  // ---- integration: waitForLogin saves diagnostics at open and at timeout, including pages opened later
  const page = mkPage('https://signin.costco.com/b2c?token=SECRETTOKEN');
  const ctxEm = emitter();
  const page2 = mkPage('https://signin.costco.com/second');
  let pages = [page];
  const ctx = Object.assign(ctxEm, { pages: () => pages, addInitScript: async () => {}, storageState: async () => ({}) });
  setTimeout(() => {
    page.emit('requestfailed', req('https://signin.costco.com/signin-btn?pw=SECRETPW', 'POST', 'net::ERR_BLOCKED_BY_CLIENT'));
    pages = [page, page2]; ctx.emit('page', page2);
    page2.emit('response', resp('https://signin.costco.com/p2/fail', 500));
  }, 30);
  const ok = await loginFlow.waitForLogin('costco', page, { timeoutMs: 350, pollMs: 40, diagAfterMs: 120, activityWindowMs: 10, context: ctx });
  assert.strictEqual(ok, false);
  const files = fs.readdirSync(debugDir);
  const timeoutDiag = files.filter(f => /^costco-login-timeout-.*\.diag\.json$/.test(f));
  const openDiag = files.filter(f => /^costco-login-open-.*\.diag\.json$/.test(f));
  assert(timeoutDiag.length >= 1, 'timeout diagnostics written: ' + files.join(','));
  assert(openDiag.length >= 1, 'periodic (open) diagnostics written: ' + files.join(','));
  assert(files.some(f => /^costco-login-timeout-.*\.png$/.test(f)), 'timeout screenshot still saved');
  const parsed = JSON.parse(fs.readFileSync(path.join(debugDir, timeoutDiag[0]), 'utf8'));
  const all = JSON.stringify(parsed);
  assert(!all.includes('SECRETPW') && !all.includes('SECRETTOKEN') && !all.includes('SECRETCOOKIE'), 'no secrets in saved diagnostics');
  assert(parsed.entries.some(e => e.url === 'https://signin.costco.com/signin-btn' && e.kind === 'requestfailed'), 'request failure on the login page captured');
  assert(parsed.entries.some(e => e.url === 'https://signin.costco.com/p2/fail' && e.status === 500), 'events from a page opened later are captured');

  console.log('test-login-diagnostics: ok');
})().catch(e => { console.error(e); process.exit(1); }).finally(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });
