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
// BFMR's API sits behind AWS WAF Bot Control: a bare Node-side fetch with valid
// session cookies + X-CSRF-Token still gets 401/403 because only a real browser
// can execute the WAF SDK's JS challenge that mints the aws-waf-token cookie.
// So every call goes through page.evaluate() (in-page fetch) -- never a Node
// http client. `page` must already be on a bfmr.com URL with a live session;
// this function neither navigates nor logs in.
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
        headers: {
          Accept: 'application/json',
          'X-CSRF-Token': csrfToken,
        },
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

module.exports = { ORDERS_URL, isLoggedOut, confirmLoggedIn, fetchTrackerRows, syncBfmr };
