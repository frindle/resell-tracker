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
  return out;
}

function authHeaders(extra) {
  return { 'X-Extension-User-Id': TRACKER_USER_ID, 'Content-Type': 'application/json', ...extra };
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
  return fetchJson(`/api/extension/commands/${id}`, { method: 'PATCH', headers: authHeaders(), body: JSON.stringify({ status, result }) });
}

async function pushOrders(orders) {
  return fetchJson('/api/import', { method: 'POST', headers: authHeaders(), body: JSON.stringify(orders) });
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

module.exports = {
  DATA_DIR, TRACKER_URL, TRACKER_USER_ID,
  sessionPath, hasSession, captureFailure,
  getSettings, setSettings, fetchCommands, patchCommand, pushOrders,
  fetchLockedOrderNumbers, logApiError, SessionExpiredError,
  launchBrowser, newContextForSite,
};
