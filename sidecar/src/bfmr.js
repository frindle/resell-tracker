'use strict';

// BFMR (buyformeretail.com) sidecar support.
//
// BFMR's POST /api/login is reCAPTCHA v3 gated and its API sits behind AWS
// WAF Bot Control, so login happens through the shared manual-VNC flow in
// loginFlow.js (SITE_CONFIG consumes ORDERS_URL + isLoggedOut below).

const ORDERS_URL = 'https://www.bfmr.com/my-tracker';

async function isLoggedOut(page) {
  const url = page.url();
  if (url.includes('/login')) return true;
  try {
    // In-page check: the login form has BOTH an email/username input and a
    // password input. Runs in the browser context, so it must be self-
    // contained (no Node-side closures).
    const hasLoginForm = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input'));
      const userField = inputs.some(i => i.type === 'email' || /user|email/i.test(i.name) || /user|email/i.test(i.id));
      const passwordField = inputs.some(i => i.type === 'password');
      return userField && passwordField;
    });
    return hasLoginForm;
  } catch {
    // Page navigated/closed mid-check: fail safe to "not logged out" rather
    // than throwing into loginFlow's polling loop.
    return false;
  }
}

// Proof that a manual-VNC login actually produced a working session: the
// interceptor stashed on window.__bfmrCaptured must contain at least one
// bfmr.com/api/my-tracker response with status 200 and the real grid shape.
async function confirmLoggedIn(page) {
  try {
    return await page.evaluate(() => {
      const captured = window.__bfmrCaptured;
      if (!Array.isArray(captured)) return false;
      for (const entry of captured) {
        const body = entry && entry.body;
        if (entry.status === 200 && body && body.data && Array.isArray(body.data.my_tracker)) return true;
      }
      return false;
    });
  } catch {
    // Page navigated/closed mid-check: fail safe to "not proven" rather than
    // throwing into loginFlow's polling loop.
    return false;
  }
}

// Fetch the full My Tracker grid through an ALREADY-logged-in Playwright page.
// BFMR's API sits behind an AWS ALB WAF. Measured 2026-10-06: Node's DEFAULT TLS
// fingerprint (fetch / node:https) is blocked there (403 text/html, awselb/2.0),
// while node:https with { ciphers: 'DEFAULT' } (or TLSv1.2) and curl reach the app
// (401 JSON unauthenticated). So the block is a TLS-fingerprint rule, not a missing
// browser-minted aws-waf-token (the earlier theory here). The sidecar still goes
// through page.evaluate() (in-page fetch) because it already holds a logged-in
// browser session whose cookies + CSRF token attach for free. `page` must already
// be on a bfmr.com URL with a live session; this function neither navigates nor
// logs in.
async function fetchTrackerRows(page, opts = {}) {
  // Same calendar-month subtraction + 'YYYY-MM-DD' format as lib/bfmrWeb.ts's dateWindow().
  const months = opts.months ?? 3;
  const end = new Date();
  const start = new Date(end);
  start.setMonth(start.getMonth() - months);
  const fmt = (d) => d.toISOString().split('T')[0];

  const pageSize = 500;
  const out = [];

  for (let pageNo = 1; pageNo <= 10; pageNo++) {
    const params = new URLSearchParams({
      page_size: String(pageSize),
      page_no: String(pageNo),
      start_date: fmt(start),
      end_date: fmt(end),
      filter_tab: opts.tab ?? 'action_needed',
      filter_status: opts.statuses ?? 'reserved,purchased,payment_error,return',
    });
    const url = `https://www.bfmr.com/api/my-tracker?${params}`;

    // In-page fetch: the page's real cookies (incl. aws-waf-token) attach via
    // credentials:'include'. The fn must be self-contained -- Playwright
    // stringifies it and runs it in the page context, so no Node closures.
    const result = await page.evaluate(async ({ url }) => {
      const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content ?? '';
      const res = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        headers: Object.assign({}, window.__bfmrAuthHeaders, {
          Accept: 'application/json',
          'X-CSRF-Token': csrfToken,
        }),
      });
      return { ok: res.ok, status: res.status, body: res.ok ? await res.json() : null };
    }, { url });

    if (!result.ok) throw new Error(`BFMR fetch tracker ${result.status}`);

    // Real shape (confirmed live): { data: { my_tracker: [...] } }. The later
    // links are defensive fallbacks only -- do not reorder.
    const rows = result.body?.data?.my_tracker ?? result.body?.my_tracker ?? result.body?.data ?? [];
    if (!Array.isArray(rows)) break;
    out.push(...rows);
    if (rows.length < pageSize) break;
  }

  return out;
}

// Full tracker sync: the sidecar poll.js SITES-map entry point (same call
// shape as syncCostco(page, ctx) in costco.js). Navigates an already-logged-in
// page to the My Tracker grid and pulls the FULL status enum -- this path is
// for full reconciliation, not just action-needed rows.
async function syncBfmr(page, ctx) {
  await page.goto(ORDERS_URL, { waitUntil: 'domcontentloaded' });
  try {
    // BFMR's WAF challenge script needs a moment after load; swallow a
    // networkidle timeout here rather than throwing.
    await page.waitForLoadState('networkidle', { timeout: 15000 });
  } catch {}
  return fetchTrackerRows(page, {
    months: 3,
    tab: 'all',
    statuses: 'reserved,purchased,payment_error,return,shipped,pkg_received,In Review,processed,set_aside,paid,cancelled,deadline,returned,closed,Not Received',
  });
}

// ---------------------------------------------------------------------------
// In-page code (runs in the browser, not Node)
// ---------------------------------------------------------------------------

// Playwright's addInitScript runs before any page script on every navigation
// in the context — same guarantee costco.js relies on. The body is a
// self-contained function: it wraps window.fetch and XHR open/send as a
// PASSIVE observer of bfmr.com/api/my-tracker traffic (the My Tracker grid's
// API), stashing { url, method, status, body } entries on
// window.__bfmrCaptured. The real network call is always performed and the
// real response always returned; observation failures never throw into the
// page.
function bfmrInterceptorSource() {
  return function () {
    if (window.__bfmrInterceptorInstalled) return;
    window.__bfmrInterceptorInstalled = true;
    window.__bfmrCaptured = window.__bfmrCaptured || [];

    const TARGET = 'bfmr.com/api/my-tracker';

    function pushCapture(entry) {
      try { window.__bfmrCaptured.push(entry); } catch { /* never break the page */ }
    }

    // Latest Authorization / X-XSRF-Token the page itself sent to the tracker
    // API (names case-insensitive); fetchTrackerRows replays them.
    function recordAuthHeader(name, value) {
      try {
        const lower = String(name).toLowerCase();
        const key = lower === 'authorization' ? 'Authorization' : lower === 'x-xsrf-token' ? 'X-XSRF-Token' : '';
        if (key) (window.__bfmrAuthHeaders = window.__bfmrAuthHeaders || {})[key] = String(value);
      } catch { /* never break the page */ }
    }

    const origFetch = window.fetch.bind(window);
    window.fetch = async function (input, init) {
      let url = '';
      let method = 'GET';
      try {
        url = typeof input === 'string' ? input : (input && input.url) ? String(input.url) : '';
        method = (init && init.method) || (typeof input !== 'string' && input && input.method) || 'GET';
      } catch { /* fall through with defaults */ }

      if (url.includes(TARGET)) {
        try {
          new Headers((init && init.headers) || (typeof input !== 'string' && input && input.headers) || undefined)
            .forEach((value, name) => recordAuthHeader(name, value));
        } catch { /* never break the page */ }
      }

      const res = await origFetch(input, init);

      if (url.includes(TARGET)) {
        let body = '';
        try {
          const text = await res.clone().text();
          try { body = JSON.parse(text); } catch { body = text; }
        } catch { /* unreadable body: keep '' */ }
        pushCapture({ url, method, status: res.status, body });
      }

      return res;
    };

    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    const origSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
      try { if ((this.__bfmrUrl || '').includes(TARGET)) recordAuthHeader(name, value); } catch { /* ignore */ }
      return origSetRequestHeader.apply(this, arguments);
    };
    XMLHttpRequest.prototype.open = function (method, url) {
      try { this.__bfmrUrl = String(url); this.__bfmrMethod = method; } catch { /* ignore */ }
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      const url = this.__bfmrUrl || '';
      if (url.includes(TARGET)) {
        try {
          this.addEventListener('load', function () {
            let body = '';
            try { body = JSON.parse(this.responseText); } catch { body = this.responseText; }
            pushCapture({ url, method: this.__bfmrMethod || 'GET', status: this.status, body });
          });
        } catch { /* never break the page */ }
      }
      return origSend.apply(this, arguments);
    };
  };
}

// Installs the interceptor on a context. Must be called before the first
// navigation (the init script has to run before any page script).
async function installInterceptor(context) {
  await context.addInitScript(bfmrInterceptorSource());
}

module.exports = { ORDERS_URL, isLoggedOut, installInterceptor, confirmLoggedIn, fetchTrackerRows, syncBfmr };
