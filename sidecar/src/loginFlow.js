'use strict';

// Shared browser-driven login-wait logic used by both the one-shot
// interactive CLI (login.js) and the always-on queue (loginQueue.js) --
// factored out so "is this page actually logged in" detection and the
// session-save/status-update logic exists in exactly one place.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { sessionPath, setSettings, captureFailure, createPageDiagnostics, saveDiagnostics } = require('./lib');
const amazon = require('./amazon');
const walmart = require('./walmart');
const costco = require('./costco');
const bfmr = require('./bfmr');

// Amazon and Walmart both prove "logged in" the same way: the orders list
// rendered. Costco can't — its orders page is an SPA shell that renders
// before (and independently of) the authenticated ecom-api call, so a
// orders-list DOM check there would pass while the session is dead. A
// working Costco session is proven by the app having made a successful
// authenticated ecom-api request (the interceptor's window.__costcoAuth) OR
// by a stable signed-in account signal (costco.confirmLoggedIn) -- the former
// alone never fires on the page a manual login lands on. Hence the per-site
// hooks.
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
    // window.__costcoAuth (fast path) OR a stable signed-in DOM signal --
    // see costco.confirmLoggedIn. The interceptor still runs for data capture.
    confirmLoggedIn: costco.confirmLoggedIn,
  },
  bfmr: {
    // Like Costco: an SPA whose tracker page renders before the authenticated
    // /api call, so a DOM check would pass on a dead session. What proves a
    // working session is a resolvable Bearer token, which the interceptor
    // captures off BFMR's own /api requests — see bfmr.js's header.
    url: bfmr.ORDERS_URL,
    isLoggedOut: bfmr.isLoggedOut,
    prepareContext: bfmr.installInterceptor,
    confirmLoggedIn: bfmr.confirmLoggedIn,
    nudge: page => page.goto(bfmr.ORDERS_URL, {waitUntil: 'domcontentloaded'}),
  },
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Snapshot all open pages for activity tracking. Returns array of {url, title}.
async function takeSnapshot(context) {
  const snap = [];
  try {
    for (const p of context.pages()) {
      if (!p.isClosed()) {
        let u; try { u = p.url(); } catch { u = ''; }
        let t; try { t = await p.title(); } catch { t = ''; }
        snap.push({ url: u, title: t });
      }
    }
  } catch {}
  return snap;
}

// Compare two snapshots; returns true if any page changed.
function snapshotsChanged(oldSnap, newSnap) {
  if (oldSnap.length !== newSnap.length) return true;
  for (let i = 0; i < oldSnap.length; i++) {
    if (oldSnap[i].url !== newSnap[i].url || oldSnap[i].title !== newSnap[i].title) return true;
  }
  return false;
}

// Navigates `page` to the site's orders/login URL and waits up to
// `timeoutMs` for a human to complete login by hand, polling every
// `pollMs`. On success, saves storageState (via `context`) to the
// session file, updates *_session_status/*_session_checked_at on the
// tracker, and returns true. On timeout, returns false -- nothing is
// saved, caller decides whether/when to retry.
async function waitForLogin(site, page, { timeoutMs = 30 * 60 * 1000, pollMs = 5000, context, onTick, activityWindowMs = 60000, hardMaxMs = 30 * 60 * 1000, diagAfterMs = 45000 } = {}) {
  const cfg = SITE_CONFIG[site];
  if (!cfg) throw new Error(`unknown site: ${site}`);
  if (!context) throw new Error('waitForLogin requires the page\'s context (for storageState)');

  // ---- Login diagnostics (Slice 3b) ----
  const diags = [];
  function addDiagFor(p) {
    try {
      const d = createPageDiagnostics(p, site);
      diags.push(d);
    } catch (_) {}
  }
  addDiagFor(page);

  // Register handler for pages opened during the polling loop.
  try {
    if (typeof context.on === 'function') {
      context.on('page', (p) => {
        addDiagFor(p);
      });
    }
  } catch (_) {}

  // Create diagnostics for any other pages already in context.pages().
  try {
    const existingPages = context.pages();
    for (const p of existingPages) {
      if (p !== page && !p.isClosed()) {
        addDiagFor(p);
      }
    }
  } catch (_) {}

  // Build a merged diagnostics object that combines all per-page diagnostics.
  const merged = {
    summary() {
      let allCounts = {};
      let allEntries = [];
      for (const d of diags) {
        const s = d.summary();
        for (const k of Object.keys(s.counts)) {
          allCounts[k] = (allCounts[k] || 0) + s.counts[k];
        }
        allEntries = allEntries.concat(s.entries);
      }
      let firstUrl = '';
      try {
        if (diags.length > 0) {
          firstUrl = diags[0].summary().url || '';
        }
      } catch (_) {}
      return { site, pages: diags.map(d => d.summary()), counts: allCounts, entries: allEntries, url: firstUrl };
    },
  };

  await page.goto(cfg.url, { waitUntil: 'domcontentloaded' });

  const NUDGE_INTERVAL = 20 * 1000;
  const nudgeTimes = new Map();

  // Activity tracking: take initial snapshot after page.goto.
  let prevSnap = await takeSnapshot(context);
  let lastActivityAt = Date.now();
  let extensionLogged = false;

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
        if (await cfg.isLoggedOut(p)) continue; // walmart's is async (content check); amazon/costco stay sync — awaiting a boolean is harmless
        // Confirm the session really works, not just "not on the login URL"
        // (e.g. mid-redirect) — see the per-site note above.
        if (await cfg.confirmLoggedIn(p)) return p;
        // BFMR SPA: tracker page renders before authenticated /api call.
        // Nudge the page to the orders view so the interceptor can capture it.
        if (cfg.nudge) {
          const last = nudgeTimes.get(p);
          if (!last || Date.now() - last > NUDGE_INTERVAL) {
            try { await cfg.nudge(p); } catch {}
            nudgeTimes.set(p, Date.now());
          }
        }
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

  // Helper: get a non-closed page for saveDiagnostics.
  function getCapturePage() {
    for (const p of context.pages()) {
      if (!p.isClosed()) return p;
    }
    return page;
  }

  const start = Date.now();
  const effectiveHardMax = Math.max(hardMaxMs, timeoutMs);
  let diagSaved = false;
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
    // Activity tracking: compare snapshots.
    const newSnap = await takeSnapshot(context);
    if (snapshotsChanged(prevSnap, newSnap)) {
      lastActivityAt = Date.now();
    }
    prevSnap = newSnap;

    const urls = openPageUrls();
    console.log(`[loginFlow] ${site} poll urls: ${urls.join(' | ') || page.url()}`);
    if (onTick) onTick(page.url());

    // Save diagnostics once when diagAfterMs is reached (and login not yet confirmed).
    if (!diagSaved && (Date.now() - start) >= diagAfterMs) {
      diagSaved = true;
      try {
        const cap = await saveDiagnostics(getCapturePage(), site, 'login-open', merged);
        console.log(`[loginFlow] ${site} open diagnostics:`, cap);
      } catch (e) {
        console.warn(`[loginFlow] open diagnostics save failed:`, e.message);
      }
    }
  }
  // timeoutMs reached — check whether to extend or give up.
  const elapsed = Date.now() - start;
  const timeSinceActivity = Date.now() - lastActivityAt;
  if (timeSinceActivity < activityWindowMs && elapsed < effectiveHardMax) {
    // Human is still active; extend the window.
    if (!extensionLogged) {
      console.log(`[loginFlow] ${site} activity detected -- extending login window`);
      extensionLogged = true;
    }
    // Re-check on later ticks until hard max or activity stops.
    while (Date.now() - start < effectiveHardMax) {
      await sleep(pollMs);
      {
        const confirmed = await findLoggedInPage();
        if (confirmed) {
          const outPath = sessionPath(site);
          try {
            await fsp.mkdir(path.dirname(outPath), { recursive: true });
            await context.storageState({ path: outPath });
            console.log(`[loginFlow] Session saved to ${outPath}`);
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
      const newSnap = await takeSnapshot(context);
      if (snapshotsChanged(prevSnap, newSnap)) {
        lastActivityAt = Date.now();
      }
      prevSnap = newSnap;
      const urls = openPageUrls();
      console.log(`[loginFlow] ${site} poll urls: ${urls.join(' | ') || page.url()}`);
      if (onTick) onTick(page.url());

      // Save diagnostics once when diagAfterMs is reached (and login not yet confirmed).
      if (!diagSaved && (Date.now() - start) >= diagAfterMs) {
        diagSaved = true;
        try {
          const cap = await saveDiagnostics(getCapturePage(), site, 'login-open', merged);
          console.log(`[loginFlow] ${site} open diagnostics:`, cap);
        } catch (e) {
          console.warn(`[loginFlow] open diagnostics save failed:`, e.message);
        }
      }
      // Check if activity has stopped: extend window from last activity.
      if (Date.now() - lastActivityAt >= activityWindowMs) {
        // Activity stopped; fall through to timeout path.
        break;
      }
    }
  }
  // Capture the most diagnostic tab on timeout: prefer one NOT stuck on
  // the sign-in URL (that's where a bot-challenge/interstitial would be),
  // falling back to our original page.
  // isLoggedOut may be async (walmart's content check), so pick the first
  // non-logged-out open page with an awaited loop rather than Array.find.
  let capturePage = null;
  for (const p of context.pages()) {
    if (p.isClosed()) continue;
    try { if (!(await cfg.isLoggedOut(p))) { capturePage = p; break; } } catch { /* page closed mid-check */ }
  }
  capturePage = capturePage || page;
  console.log(`[loginFlow] ${site} login timed out; open urls: ${openPageUrls().join(' | ')}`);
  // Replace captureFailure with saveDiagnostics for login-timeout.
  try {
    const cap = await saveDiagnostics(capturePage, site, 'login-timeout', merged);
    console.log(`[loginFlow] ${site} timeout capture:`, cap);
  } catch (e) {
    console.warn(`[loginFlow] timeout capture failed: ${e.message}`);
  }
  return false;
}

module.exports = { SITE_CONFIG, waitForLogin };
