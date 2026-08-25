'use strict';

// Shared browser-driven login-wait logic used by both the one-shot
// interactive CLI (login.js) and the always-on queue (loginQueue.js) --
// factored out so "is this page actually logged in" detection and the
// session-save/status-update logic exists in exactly one place.

const { sessionPath, setSettings } = require('./lib');
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
  amazon: { url: amazon.ORDERS_URL, isLoggedOut: amazon.isLoggedOut, confirmLoggedIn: ordersListRendered },
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

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(pollMs);
    if (!cfg.isLoggedOut(page)) {
      // Confirm the session really works, not just "not on the login URL"
      // (e.g. mid-redirect) — see the per-site note above.
      const hasOrders = await cfg.confirmLoggedIn(page);
      if (hasOrders) {
        const outPath = sessionPath(site);
        await context.storageState({ path: outPath });
        try {
          await setSettings({ [`${site}_session_status`]: 'active', [`${site}_session_checked_at`]: new Date().toISOString() });
        } catch (e) {
          console.warn(`[loginFlow] could not update session status on tracker (non-fatal): ${e.message}`);
        }
        return true;
      }
    }
    if (onTick) onTick(page.url());
  }
  return false;
}

module.exports = { SITE_CONFIG, waitForLogin };
