'use strict';

// Shared browser-driven login-wait logic used by both the one-shot
// interactive CLI (login.js) and the always-on queue (loginQueue.js) --
// factored out so "is this page actually logged in" detection and the
// session-save/status-update logic exists in exactly one place.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { sessionPath, setSettings, captureFailure } = require('./lib');
const amazon = require('./amazon');
const walmart = require('./walmart');
const costco = require('./costco');

// Amazon and Walmart both prove "logged in" the same way: the orders list
// rendered. Costco can't — its orders page is an SPA shell that renders
// before (and independently of) the authenticated ecom-api call, so a
// DOM check there would pass while the session is dead. What actually
// proves a working Costco session is the app having made a successful
// authenticated ecom-api request, which is exactly what the interceptor
// records as window.__costcoAuth. Hence the per-site hooks.
function ordersListRendered(page) {
  return page.evaluate(() =>
    document.querySelectorAll('a[href*="orderID="], a[href*="orderId="], a[href*="order-details"], [data-testid*="orderGroup"], [data-testid*="order-card"], [data-testid*="orderCard"]').length > 0
  ).catch(() => false);
}

const SITE_CONFIG = {
  amazon: { url: amazon.ORDERS_URL, isLoggedOut: amazon.isLoggedOut, confirmLoggedIn: amazon.confirmLoggedIn },
  walmart: { url: walmart.ORDERS_URL, isLoggedOut: walmart.isLoggedOut, confirmLoggedIn: ordersListRendered },
  costco: {
    url: costco.ORDERS_URL,
    isLoggedOut: costco.isLoggedOut,
    prepareContext: costco.installInterceptor,
    confirmLoggedIn: page => page.evaluate(() => !!window.__costcoAuth).catch(() => false),
  },
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Navigates `page` to the site's orders/login URL and waits up to
// `timeoutMs` for a human to complete login by hand, polling every
// `pollMs`. On success, saves storageState (via `context`) to the
// session file, updates *_session_status/*_session_checked_at on the
// tracker, and returns true. On timeout, returns false -- nothing is
// saved, caller decides whether/when to retry.
async function waitForLogin(site, page, { timeoutMs = 30 * 60 * 1000, pollMs = 5000, context, onTick } = {}) {
  const cfg = SITE_CONFIG[site];
  if (!cfg) throw new Error(`unknown site: ${site}`);
  if (!context) throw new Error('waitForLogin requires the page\'s context (for storageState)');

  await page.goto(cfg.url, { waitUntil: 'domcontentloaded' });

  // Find a logged-in page anywhere in the context, not just the tab we
  // opened. A human completing login by hand can land the authenticated
  // session in a *different* tab (Amazon in particular sometimes opens
  // orders in a new tab, or the sign-in flow spawns one), leaving our
  // original page parked on /ap/signin. Polling only that page would then
  // time out forever even though the context is fully logged in. Since
  // storageState is saved from the shared context (not a single page),
  // any page proving login is sufficient. Returns the confirming page, or
  // null. Closed/navigating pages are skipped rather than throwing.
  async function findLoggedInPage() {
    for (const p of context.pages()) {
      if (p.isClosed()) continue;
      try {
        if (cfg.isLoggedOut(p)) continue;
        // Confirm the session really works, not just "not on the login URL"
        // (e.g. mid-redirect) — see the per-site note above.
        if (await cfg.confirmLoggedIn(p)) return p;
      } catch {
        // page navigated/closed under us this tick — ignore, retry next poll
      }
    }
    return null;
  }

  // URLs of every open page, for diagnostics (guards against a page that
  // closed between the pages() snapshot and the url() read).
  function openPageUrls() {
    return context.pages().flatMap(p => {
      try { return p.isClosed() ? [] : [p.url()]; } catch { return []; }
    });
  }

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(pollMs);
    {
      const confirmed = await findLoggedInPage();
      if (confirmed) {
        const outPath = sessionPath(site);
        try {
          // Ensure directory exists
          await fsp.mkdir(path.dirname(outPath), { recursive: true });
          await context.storageState({ path: outPath });
          console.log(`[loginFlow] Session saved to ${outPath}`);
          
          // Verify the file was written correctly
          if (fs.existsSync(outPath)) {
            const stats = fs.statSync(outPath);
            console.log(`[loginFlow] Session file size: ${stats.size} bytes`);
          } else {
            console.warn(`[loginFlow] Session file was not created at ${outPath}`);
          }
        } catch (e) {
          console.error(`[loginFlow] Failed to save session:`, e.message);
          throw e;
        }
        
        try {
          await setSettings({ [`${site}_session_status`]: 'active', [`${site}_session_checked_at`]: new Date().toISOString() });
        } catch (e) {
          console.warn(`[loginFlow] could not update session status on tracker (non-fatal): ${e.message}`);
        }
        return true;
      }
    }
    const urls = openPageUrls();
    console.log(`[loginFlow] ${site} poll urls: ${urls.join(' | ') || page.url()}`);
    if (onTick) onTick(page.url());
  }
  // Capture the most diagnostic tab on timeout: prefer one NOT stuck on
  // the sign-in URL (that's where a bot-challenge/interstitial would be),
  // falling back to our original page.
  const capturePage = context.pages().find(p => !p.isClosed() && !cfg.isLoggedOut(p)) || page;
  console.log(`[loginFlow] ${site} login timed out; open urls: ${openPageUrls().join(' | ')}`);
  try { const cap = await captureFailure(capturePage, site, 'login-timeout'); console.log(`[loginFlow] ${site} timeout capture:`, cap); } catch (e) { console.warn(`[loginFlow] timeout capture failed: ${e.message}`); }
  return false;
}

module.exports = { SITE_CONFIG, waitForLogin };
