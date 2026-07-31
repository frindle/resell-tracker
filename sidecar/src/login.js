'use strict';

// One-time interactive login. Run via:
//   docker exec -it <container> node src/login.js amazon
//   docker exec -it <container> node src/login.js walmart
//
// Opens a real, human-visible Chrome window on the container's Xvfb
// display (:99) — connect a VNC client to <container-ip>:5900 (password
// from VNC_PASSWORD / the one printed in `docker logs` on startup)
// BEFORE running this, so the window is visible when the site's login
// form appears. Log in like a normal person (2FA included — the CAPTCHA
// research finding is specifically about *automated* login attempts;
// a real human driving a real browser over VNC isn't automated). Once
// the orders page loads successfully, this script saves the session
// (storageState) to /data/sessions/<site>-session.json and exits. Every
// later poll-loop run reuses that file headlessly-in-appearance-only
// (still headed under Xvfb, just unattended) — no password is ever
// stored.

const { sessionPath, setSettings, launchBrowser } = require('./lib');
const amazon = require('./amazon');
const walmart = require('./walmart');

const SITE = process.argv[2];
const CONFIG = {
  amazon: { url: amazon.ORDERS_URL, isLoggedOut: amazon.isLoggedOut },
  walmart: { url: walmart.ORDERS_URL, isLoggedOut: walmart.isLoggedOut },
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const POLL_MS = 5000;
const TIMEOUT_MS = 30 * 60 * 1000; // 30 min to complete login by hand

async function main() {
  const cfg = CONFIG[SITE];
  if (!cfg) {
    console.error(`Usage: node src/login.js <amazon|walmart>`);
    process.exit(1);
  }

  console.log(`[login] Launching ${SITE} — connect VNC to view/control this window.`);
  const browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.goto(cfg.url, { waitUntil: 'domcontentloaded' });

  console.log(`[login] Waiting for you to finish logging in at ${cfg.url} (up to 30 minutes)...`);
  const start = Date.now();
  let loggedIn = false;
  while (Date.now() - start < TIMEOUT_MS) {
    await sleep(POLL_MS);
    const url = page.url();
    if (!cfg.isLoggedOut(page)) {
      // Confirm the orders list actually rendered, not just "not on the
      // login URL" (e.g. mid-redirect).
      const hasOrders = await page.evaluate(() =>
        document.querySelectorAll('a[href*="orderID="], a[href*="orderId="], a[href*="order-details"], [data-testid*="orderGroup"], [data-testid*="order-card"], [data-testid*="orderCard"]').length > 0
      ).catch(() => false);
      if (hasOrders) { loggedIn = true; break; }
    }
    console.log(`[login] still waiting... current url: ${url}`);
  }

  if (!loggedIn) {
    console.error('[login] Timed out waiting for login. Re-run this command to try again — nothing was saved.');
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    process.exit(1);
  }

  const outPath = sessionPath(SITE);
  await context.storageState({ path: outPath });
  console.log(`[login] Saved session to ${outPath}`);

  await context.close().catch(() => {});
  await browser.close().catch(() => {});

  try {
    await setSettings({ [`${SITE}_session_status`]: 'active', [`${SITE}_session_checked_at`]: new Date().toISOString() });
  } catch (e) {
    console.warn('[login] could not update session status on tracker (non-fatal):', e.message);
  }

  console.log('[login] Done.');
}

main().catch(e => { console.error('[login] fatal:', e); process.exit(1); });
