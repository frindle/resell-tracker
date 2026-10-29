'use strict';

// Shared helpers for the headless sidecar: talking to the existing
// resell-tracker API (same endpoints + header auth pattern the browser
// extension already uses — see /api/import, /api/extension/commands,
// /api/api-errors), session-file paths on the shared /data volume, and
// failure-debug capture.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || '/data';
const TRACKER_URL = (process.env.TRACKER_URL || '').replace(/\/$/, '');
const TRACKER_USER_ID = process.env.TRACKER_USER_ID || '';
const EXTENSION_SHARED_SECRET = process.env.EXTENSION_SHARED_SECRET || '';

if (!TRACKER_URL) throw new Error('TRACKER_URL env var is required');
if (!TRACKER_USER_ID) throw new Error('TRACKER_USER_ID env var is required (which tracker user this sidecar imports orders as)');

function sessionPath(site) {
  return path.join(DATA_DIR, 'sessions', `${site}-session.json`);
}

function hasSession(site) {
  return fs.existsSync(sessionPath(site));
}

function debugPath(site, label, ext) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(DATA_DIR, 'debug', `${site}-${label}-${ts}.${ext}`);
}

// Screenshot + full page HTML on failure — there's no live DevTools
// access to an unattended run, so this is the only forensic trail.
async function captureFailure(page, site, label) {
  const out = { screenshot: null, html: null };
  try {
    const shotPath = debugPath(site, label, 'png');
    await page.screenshot({ path: shotPath, fullPage: true });
    out.screenshot = shotPath;
  } catch (e) {
    console.warn(`[${site}] screenshot capture failed:`, e.message);
  }
  try {
    const htmlPath = debugPath(site, label, 'html');
    const html = await page.content();
    await fsp.writeFile(htmlPath, html);
    out.html = htmlPath;
  } catch (e) {
    console.warn(`[${site}] html capture failed:`, e.message);
  }
  try { pruneDebugDir(); } catch (_) {}
  return out;
}

function authHeaders(extra) {
  const headers = { 'X-Extension-User-Id': TRACKER_USER_ID, 'Content-Type': 'application/json', ...extra };
  if (EXTENSION_SHARED_SECRET) headers['X-Extension-Secret'] = EXTENSION_SHARED_SECRET;
  return headers;
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(`${TRACKER_URL}${url}`, opts);
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    const err = new Error(`${opts.method || 'GET'} ${url} → HTTP ${res.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

async function getSettings() {
  return fetchJson('/api/settings', { headers: authHeaders() });
}

async function setSettings(obj) {
  return fetchJson('/api/settings', { method: 'POST', headers: authHeaders(), body: JSON.stringify(obj) });
}

async function fetchCommands() {
  return fetchJson('/api/extension/commands', { headers: authHeaders({ 'X-Extension-Browser': 'sidecar' }) });
}

async function patchCommand(id, status, result) {
  // X-Extension-Browser was sent on the GET poll (fetchCommands, for the
  // target-browser filter) but never on this PATCH -- meaning nothing ever
  // recorded whether a given command actually ran via the sidecar or the
  // real browser extension. The extension itself already sends this same
  // header on its own PATCH calls; the sidecar was the one gap.
  return fetchJson(`/api/extension/commands/${id}`, { method: 'PATCH', headers: authHeaders({ 'X-Extension-Browser': 'sidecar' }), body: JSON.stringify({ status, result }) });
}

async function pushOrders(orders) {
  return fetchJson('/api/import', { method: 'POST', headers: authHeaders(), body: JSON.stringify(orders) });
}

// Same sink BFMR My Tracker rows need (sync-reservations). The route
// accepts { trigger, webRows } and answers with webRowsAccepted.
async function pushBfmrWebRows(rows) {
  return fetchJson('/api/bfmr/sync-reservations', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ trigger: 'sidecar', webRows: rows }),
  });
}

// Same sink the extension's costco.ts used (PUSH_COSTCO_RECEIPTS ->
// POST /api/costco/receipts). The route accepts both a bare array and
// { receipts }; send the object form, which is the newer shape.
async function pushCostcoReceipts(receipts) {
  return fetchJson('/api/costco/receipts', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ receipts }),
  });
}

// Same sink the extension's CBM_SCRAPE_DONE handler posted to. Payload is
// a bare array of { merchant, rates: [{ portal, rate, category }] }.
async function pushPortalRates(entries) {
  return fetchJson('/api/portal-rates/bulk', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(entries),
  });
}

// Merchant list for SCRAPE_CBM when the command carries no payload —
// identical fallback to the extension's runScrapeCbm().
async function fetchBfmrVendors() {
  const data = await fetchJson('/api/bfmr/vendors', { headers: authHeaders() });
  return Array.isArray(data) ? data : [];
}

async function fetchLockedOrderNumbers(platform) {
  try {
    const data = await fetchJson(`/api/orders/locked-order-numbers?platform=${platform}`, { headers: authHeaders() });
    return new Set(data.orderNumbers || []);
  } catch (e) {
    console.warn(`[lib] locked-order-numbers fetch failed, proceeding without skip:`, e.message);
    return new Set();
  }
}

// Orders still missing a tracking number after the sync that just ran --
// see app/api/orders/missing-tracking/route.ts for the exact criteria
// (non-cancelled, non-lost, within the app's own "still worth checking"
// age bound). Best-effort: a failure here should never fail the sync
// whose result it's following up on.
async function fetchMissingTrackingOrderNumbers(platform) {
  try {
    const data = await fetchJson(`/api/orders/missing-tracking?platform=${platform}`, { headers: authHeaders() });
    return data.orderNumbers || [];
  } catch (e) {
    console.warn(`[lib] missing-tracking fetch failed, skipping backfill dispatch:`, e.message);
    return [];
  }
}

// Self-dispatches a follow-up command onto the same queue this sidecar
// polls -- used right after a full sync to queue a targeted resync for
// orders it just found are still missing tracking, without waiting for
// the next windowed sweep to maybe reach them.
async function queueCommand(type, payload) {
  return fetchJson('/api/extension/commands', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ type, targetBrowser: 'sidecar', payload }),
  });
}

// Same sink the browser extension's API-spy uses for non-2xx responses —
// this also fires the existing Pushover-on-failure path server-side
// (lib/apiErrorLog.ts), so session-expired / scrape-failure alerts reuse
// the tracker's existing notification wiring, no new alerting code here.
async function logApiError({ group, endpoint, method, status, body, context }) {
  try {
    await fetchJson('/api/api-errors', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ group, endpoint, method, status, body, context }),
    });
  } catch (e) {
    console.error('[lib] logApiError itself failed:', e.message);
  }
}

const { chromium } = require('playwright-core');

// Always headed (headless:false) against the container's Xvfb display —
// see Dockerfile/entrypoint.sh comments for why. Used both for the
// interactive one-time login and the unattended poll-loop runs.
async function launchBrowser() {
  return chromium.launch({
    headless: false,
    executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome-stable',
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1280,900',
    ],
  });
}

async function newContextForSite(browser, site, { requireSession = true } = {}) {
  const statePath = sessionPath(site);
  if (requireSession && !fs.existsSync(statePath)) {
    throw new SessionExpiredError(site);
  }
  
  // Ensure the data directory exists before creating context
  try {
    await fsp.mkdir(path.dirname(statePath), { recursive: true });
  } catch (e) {
    console.warn(`[lib] failed to create session dir for ${site}:`, e.message);
  }
  
  return browser.newContext({
    storageState: fs.existsSync(statePath) ? statePath : undefined,
    viewport: { width: 1280, height: 900 },
  });
}

class SessionExpiredError extends Error {
  constructor(site) {
    super(`${site} session expired or not logged in`);
    this.name = 'SessionExpiredError';
    this.site = site;
  }
}

class AmazonBlockedError extends Error {
  constructor(site) {
    super(`${site || 'amazon'}: Amazon blocked automated access (bot-check interstitial). A person must click Continue in the sidecar browser session, then trigger a manual sync.`);
    this.name = 'AmazonBlockedError';
    this.site = site || 'amazon';
  }
}

const SIDECAR_SHARED_SECRET = process.env.SIDECAR_SHARED_SECRET || '';

// Fetches the current set of user-configured VNC passwords and rewrites
// x11vnc's -passwdfile in place. x11vnc re-reads that file on each new
// connection attempt ONLY because entrypoint.sh launches it with
// `-passwdfile read:/tmp/.vnc/passwd` (the "read:" prefix, not cosmetic --
// per x11vnc's source, a plain -passwdfile is read once at startup and
// never again, silently authenticating forever against whatever was
// there at boot). So no restart/signal is needed for a change here to
// take effect -- called both by the boot-time entrypoint.sh retry loop
// and by refreshVncPasswordFile's own HTTP listener (pushed to
// immediately on save from the main app, see app/api/settings/route.ts)
// rather than relying on a slow poll interval alone.
//
// -passwdfile takes PLAIN TEXT passwords, one per line (first line =
// full-access, see x11vnc's own FAQ) -- it is NOT the same format as
// -storepasswd's obfuscated output, which is for the separate -rfbauth
// option. Piping -storepasswd's output into -passwdfile (the previous
// approach here) silently fails auth for every password regardless of
// length -- confirmed independently the same night on a second x11vnc
// deployment (ev-dashboard Pi / IPMIView) via a raw RFB client showing
// storepasswd-generated files failing server-side while the identical
// plaintext password succeeded. No obfuscation step needed at all.
async function refreshVncPasswordFile() {
  if (!SIDECAR_SHARED_SECRET) return { ok: false, reason: 'SIDECAR_SHARED_SECRET not set' };
  const res = await fetch(`${TRACKER_URL}/api/sidecar/vnc-passwords`, {
    headers: { 'X-Sidecar-Secret': SIDECAR_SHARED_SECRET },
  });
  if (!res.ok) return { ok: false, reason: `fetch failed: HTTP ${res.status}` };
  const { passwords } = await res.json();
  const fallback = process.env.VNC_PASSWORD;
  const all = (passwords && passwords.length > 0) ? passwords : (fallback ? [fallback] : []);
  if (all.length === 0) return { ok: false, reason: 'no passwords configured and no VNC_PASSWORD fallback' };

  fs.writeFileSync('/tmp/.vnc/passwd', all.join('\n') + '\n');
  return { ok: true, count: all.length };
}

const crypto = require('crypto');

// Login-diagnostics helpers: record console/network events from a page,
// sanitise sensitive data, save summaries for debugging failed logins.

/** Sanitize a string by redacting Bearer tokens and long base64-like sequences */
function sanitize(text) {
  if (typeof text !== 'string') return String(text);
  let result = text.replace(/Bearer\s+\S+/g, 'Bearer [redacted]');
  result = result.replace(/[A-Za-z0-9_\-+/=]{24,}/g, '[redacted]');
  return result;
}

/** Build a safe URL: origin + pathname only (no query, hash, credentials) */
function safeUrl(u) {
  try {
    const parsed = new URL(u);
    const cleanPath = parsed.pathname || '/';
    return parsed.origin + cleanPath;
  } catch (_) {
    return '[unparsable]';
  }
}

/**
 * createPageDiagnostics(page, site, {max=50}) -> object with summary() method.
 * Registers listeners on `page` via page.on to capture console errors/warnings,
 * pageerrors, request failures, HTTP error responses, and frame navigations.
 */
function createPageDiagnostics(page, site, options) {
  const max = (options && typeof options.max === 'number') ? options.max : 50;

  const counts = { console: 0, pageerror: 0, requestfailed: 0, http_error: 0, nav: 0 };
  const entries = [];

  function pushEntry(entry) {
    counts[entry.kind]++;
    if (entries.length < max) {
      entries.push(entry);
    }
    logEntry(entry.kind, entry);
  }

  function handleConsole(msg, pushEntryFn) {
    try {
      const type = msg.type();
      if (type === 'error' || type === 'warning') {
        let text = sanitize(String(msg.text()));
        if (text.length > 200) text = text.substring(0, 200);
        const entry = { kind: 'console', type, text };
        pushEntryFn(entry);
      }
    } catch (_) {}
  }

  function handlePageError(err, pushEntryFn) {
    try {
      let message = String((err && err.message) || '');
      const sanitized = sanitize(message).substring(0, 200);
      const entry = { kind: 'pageerror', text: sanitized };
      pushEntryFn(entry);
    } catch (_) {}
  }

  function handleRequestFailed(reqObj, pushEntryFn) {
    try {
      const entry = {
        kind: 'requestfailed',
        method: String((reqObj && reqObj.method ? reqObj.method() : '')),
        url: safeUrl(reqObj.url()),
        error: (reqObj.failure && typeof reqObj.failure === 'function') ? (reqObj.failure()?.errorText || '') : '',
      };
      pushEntryFn(entry);
    } catch (_) {}
  }

  function handleResponse(respObj, pushEntryFn) {
    try {
      const status = respObj.status();
      if (status >= 400) {
        const entry = {
          kind: 'http_error',
          status,
          method: String((respObj.request && typeof respObj.request === 'function') ? (respObj.request().method() || '') : ''),
          url: safeUrl(respObj.url()),
        };
        pushEntryFn(entry);
      }
    } catch (_) {}
  }

  function handleFrameNavigated(frame, pushEntryFn) {
    try {
      const pf = typeof frame.parentFrame === 'function' ? frame.parentFrame() : undefined;
      if (pf !== null) return;
      try { pushEntryFn({ kind: 'nav', url: safeUrl(String((typeof frame.url === 'function') ? frame.url() : '')) }); } catch (_) {}
    } catch (_) {}
  }

  function logEntry(kind, data) {
    let msg;
    switch (kind) {
      case 'console':
        msg = `[${site}/page:console] ${data.text}`;
        break;
      case 'pageerror':
        msg = `[${site}/page:pageerror] ${data.text}`;
        break;
      case 'requestfailed': {
        const safeUrlStr = typeof data.url === 'string' ? safeUrl(data.url || '') : '[unparsable]';
        msg = `[${site}/page:requestfailed] ${safeUrlStr}`;
        if (data.error && String(data.error).trim() !== '') {
          const errText = typeof data.error === 'string' ? sanitize(String(data.error)) : '';
          msg += ` ${errText}`;
        } else {
          break;
        }
      }
        break;
      case 'http_error': {
        const status = data.status || '';
        const rMethod = String(data.method || '');
        const rUrl = safeUrl(String((typeof data.url === 'string') ? data.url : ''));
        msg = `[${site}/page:response] ${status} ${rMethod} ${rUrl}`;
      }
        break;
      case 'nav': {
        const navUrl = typeof data === 'string' ? safeUrl(data || '') : ((data && data.url) ? safeUrl(String(data.url)) : '[unparsable]');
        msg = `[${site}/page:nav] ${navUrl}`;
      }
        break;
      default:
        return;
    }
    console.log(msg);
  }

  try { page.on('console', (msg) => handleConsole(msg, pushEntry)); } catch (_) {}
  try { page.on('pageerror', (err) => handlePageError(err, pushEntry)); } catch (_) {}
  try { page.on('requestfailed', (reqObj) => handleRequestFailed(reqObj, pushEntry)); } catch (_) {}
  try { page.on('response', (respObj) => handleResponse(respObj, pushEntry)); } catch (_) {}
  try { page.on('framenavigated', (frame) => handleFrameNavigated(frame, pushEntry)); } catch (_) {}

  return Object.freeze({
    summary() {
      let pageUrl;
      try { pageUrl = safeUrl(String((typeof page.url === 'function') ? page.url() : '')); } catch (_) { pageUrl = ''; }
      return Object.freeze({
        site, url: pageUrl || '', counts: Object.assign({}, counts), entries: Array.prototype.slice.call(entries) });
    },
  });
}

/**
 * saveDiagnostics(page, site, label, diag): async. Saves screenshot + HTML via captureFailure,
 * writes the diagnostics summary to DATA_DIR/debug as JSON. Returns {screenshot, html, diag}.
 */
async function saveDiagnostics(page, site, label, diag) {
  try {
    await fsp.mkdir(path.join(DATA_DIR, 'debug'), { recursive: true });

    const shot = captureFailure ? await captureFailure(page, site, label).catch(() => ({ screenshot: null, html: null })) : { screenshot: null, html: null };
    
    const diagJson = JSON.stringify(
      (typeof diag === 'object' && typeof diag.summary === 'function') ? diag.summary() : {}, null, 2);

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const diagFilePath = path.join(DATA_DIR, 'debug', `${site}-${label}-${ts}.diag.json`);

    await fsp.writeFile(diagFilePath, diagJson);

    return Object.assign({}, shot, { diag: diagFilePath });
  } catch (e) {
    console.warn(`[saveDiagnostics] failed for ${site}/${label}:`, e.message);
    try {
      await fsp.mkdir(path.join(DATA_DIR, 'debug'), { recursive: true });
    } catch (_) {}
    return Object.assign({}, shot || {}, { diag: null });
  }
}

function browserLockPath() {
  return path.join(DATA_DIR, 'browser.lock');
}

class BrowserBusyError extends Error {
  constructor(holder) {
    super(`${holder.kind} in progress (${holder.site})`);
    this.name = 'BrowserBusyError';
    this.holder = holder;
  }
}

function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) {
    return e.code !== 'ESRCH'; // EPERM = alive, ESRCH = dead
  }
}

async function acquireBrowserLock(kind, { site, waitMs = 0, pollMs = 250, staleMs = 45 * 60 * 1000, heartbeatMs = 15000, heartbeatStaleMs = 90000 } = {}) {
  const lockFile = browserLockPath();
  const token = crypto.randomBytes(16).toString('hex');
  const startedAt = Date.now();
  let intervalId = null;

  const ensureDir = async () => {
    try { await fsp.mkdir(DATA_DIR, { recursive: true }); } catch {}
  };

  const writeLock = async (holder) => {
    await ensureDir();
    const data = JSON.stringify({ pid: process.pid, kind: holder.kind, site: holder.site, startedAt: startedAt, token });
    fs.writeFileSync(lockFile, data, { flag: 'wx' });
  };

  const readHolder = () => {
    const raw = fs.readFileSync(lockFile, 'utf8');
    return JSON.parse(raw);
  };

  const isStale = (holder) => {
    if (!holder || typeof holder !== 'object') return true;
    if (!isPidAlive(holder.pid)) return true;
    if (Date.now() - holder.startedAt > staleMs) return true;
    try {
      const stats = fs.statSync(lockFile);
      if (Date.now() - stats.mtimeMs > heartbeatStaleMs) return true;
    } catch {}
    return false;
  };

  const checkFile = async () => {
    if (!fs.existsSync(lockFile)) return null;
    try {
      const holder = readHolder();
      if (isStale(holder)) return 'stale';
      return holder;
    } catch {
      // unparsable
      try {
        const stats = fs.statSync(lockFile);
        if (Date.now() - stats.mtimeMs > staleMs) return 'stale';
      } catch {}
      return null;
    }
  };

  const startHeartbeat = () => {
    intervalId = setInterval(() => {
      try {
        const raw = fs.readFileSync(lockFile, 'utf8');
        const data = JSON.parse(raw);
        if (data.token === token) {
          fs.utimesSync(lockFile, new Date(), new Date());
        }
      } catch {}
    }, heartbeatMs);
    intervalId.unref();
  };

  const release = async () => {
    try {
      if (intervalId) { clearInterval(intervalId); intervalId = null; }
      const raw = fs.readFileSync(lockFile, 'utf8');
      const data = JSON.parse(raw);
      if (data.token === token) fs.unlinkSync(lockFile);
    } catch {}
  };

  const holder = await checkFile();
  if (holder === 'stale') {
    fs.unlinkSync(lockFile);
    await writeLock({ kind, site });
    startHeartbeat();
    return release;
  }

  if (holder) {
    const startTime = Date.now();
    while (true) {
      const elapsed = Date.now() - startTime;
      if (elapsed >= waitMs) {
        const current = await checkFile();
        if (current && current !== 'stale') {
          throw new BrowserBusyError(current);
        }
        break;
      }
      await new Promise(r => setTimeout(r, pollMs));
    }
  }

  await writeLock({ kind, site });
  startHeartbeat();
  return release;
}

module.exports = {
  DATA_DIR, TRACKER_URL, TRACKER_USER_ID,
  sessionPath, hasSession, captureFailure,
  getSettings, setSettings, fetchCommands, patchCommand, pushOrders,
  pushCostcoReceipts, pushPortalRates, pushBfmrWebRows, fetchBfmrVendors,
  fetchLockedOrderNumbers, fetchMissingTrackingOrderNumbers, queueCommand,
  logApiError, SessionExpiredError, AmazonBlockedError,
  launchBrowser, newContextForSite, refreshVncPasswordFile,
  createPageDiagnostics, saveDiagnostics,
  browserLockPath, BrowserBusyError, acquireBrowserLock,
};

function pruneDebugDir(now) {
  if (now === undefined) now = Date.now();
  const dir = path.join(DATA_DIR, 'debug');
  const raw = process.env.DEBUG_RETENTION_DAYS;
  let retentionDays = 7;
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) retentionDays = n;
  }
  let count = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const dirent of entries) {
      if (dirent.isFile()) {
        const filePath = path.join(dir, dirent.name);
        try {
          const st = fs.statSync(filePath);
          if (st.mtimeMs < now - retentionDays * 86400000) {
            fs.unlinkSync(filePath);
            count++;
          }
        } catch (_) {}
      }
    }
  } catch (_) {}
  return count;
}

Object.assign(module.exports, { pruneDebugDir });
try { pruneDebugDir(); } catch (_) {}
