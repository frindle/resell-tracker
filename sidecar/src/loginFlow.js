'use strict';

// Shared browser-driven login-wait logic used by both the one-shot
// interactive CLI (login.js) and the always-on queue (loginQueue.js) --
// factored out so "is this page actually logged in" detection and the
// session-save/status-update logic exists in exactly one place.

const { sessionPath, setSettings } = require('./lib');
const amazon = require('./amazon');
const walmart = require('./walmart');
const costco = require('./costco');

// `hasOrders` (optional) is a per-site in-page predicate that confirms the
// orders view actually rendered, not just that we left the login URL. Sites
// without one fall back to the generic Amazon/Walmart order-card selectors.
// Costco is a hash-routed SPA with none of those, so it gets its own check.
const SITE_CONFIG = {
  amazon: { url: amazon.ORDERS_URL, isLoggedOut: amazon.isLoggedOut },
  walmart: { url: walmart.ORDERS_URL, isLoggedOut: walmart.isLoggedOut },
  costco: {
    url: costco.ORDERS_URL,
    isLoggedOut: costco.isLoggedOut,
    // Logged in once the myaccount app shell is up: not on signin, and the
    // account SPA root exists. Order data loads async after this, so we
    // don't require an order row to be present.
    hasOrders: () => !/signin\.costco\.com|\/logon|\/login/i.test(location.href)
      && /costco\.com\/myaccount/i.test(location.href),
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
      // Confirm the orders list actually rendered, not just "not on the
      // login URL" (e.g. mid-redirect).
      const hasOrders = await page.evaluate(
        cfg.hasOrders
          ? cfg.hasOrders
          : () => document.querySelectorAll('a[href*="orderID="], a[href*="orderId="], a[href*="order-details"], [data-testid*="orderGroup"], [data-testid*="order-card"], [data-testid*="orderCard"]').length > 0
      ).catch(() => false);
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
