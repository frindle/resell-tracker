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
//
// You normally don't need to run this manually anymore -- loginQueue.js
// runs continuously alongside poll.js and opens exactly this same flow
// automatically on the VNC display whenever a site needs it. This
// script remains for on-demand/manual re-login.

const { launchBrowser, sessionPath } = require('./lib');
const { waitForLogin, SITE_CONFIG } = require('./loginFlow');

const SITE = process.argv[2];
const TIMEOUT_MS = 30 * 60 * 1000; // 30 min to complete login by hand

async function main() {
  const cfg = SITE_CONFIG[SITE];
  if (!cfg) {
    console.error(`Usage: node src/login.js <${Object.keys(SITE_CONFIG).join('|')}>`);
    process.exit(1);
  }

  console.log(`[login] Launching ${SITE} — connect VNC to view/control this window.`);
  const browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  // Costco's login confirmation depends on the request interceptor being
  // installed before the first navigation (see loginFlow.js).
  if (cfg.prepareContext) await cfg.prepareContext(context);
  const page = await context.newPage();

  console.log(`[login] Waiting for you to finish logging in at ${cfg.url} (up to 30 minutes)...`);
  const loggedIn = await waitForLogin(SITE, page, {
    timeoutMs: TIMEOUT_MS,
    context,
    onTick: url => console.log(`[login] still waiting... current url: ${url}`),
  });

  if (!loggedIn) {
    console.error('[login] Timed out waiting for login. Re-run this command to try again — nothing was saved.');
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    process.exit(1);
  }

  // Additional verification that session is properly saved
  const outPath = sessionPath(SITE);
  console.log(`[login] Verifying session file exists at ${outPath}`);
  
  try {
    if (require('fs').existsSync(outPath)) {
      const stats = require('fs').statSync(outPath);
      console.log(`[login] Session saved successfully (${stats.size} bytes)`);
    } else {
      console.warn('[login] Session file was not created');
    }
  } catch (e) {
    console.error('[login] Error checking session file:', e.message);
  }

  await context.close().catch(() => {});
  await browser.close().catch(() => {});
  console.log('[login] Done.');
}

main().catch(e => { console.error('[login] fatal:', e); process.exit(1); });
