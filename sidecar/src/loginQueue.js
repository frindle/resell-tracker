'use strict';

// Always-on companion to poll.js: when a site (amazon/walmart) has no
// valid session, keeps a real Chrome window open on the shared Xvfb
// display sitting on that site's login page, so connecting via VNC
// immediately shows exactly what needs attention -- no need to already
// know which site needs login, or to manually run login.js yourself.
//
// Session-expiry NOTIFICATION already happens elsewhere and is left
// alone: poll.js's handleCommand() calls logApiError() when a real sync
// hits SessionExpiredError, which fires a real Pushover push via
// lib/apiErrorLog.ts. This script only reacts to that state, it doesn't
// duplicate the alerting.

const { hasSession, getSettings, launchBrowser, acquireBrowserLock, BrowserBusyError } = require('./lib');
const loginFlow = require('./loginFlow');

const CHECK_INTERVAL_MS = parseInt(process.env.LOGIN_QUEUE_CHECK_MS || '30000', 10);
// Shorter than login.js's interactive 30-min default -- this runs
// unattended and just retries after every timeout, so a shorter window
// means less time showing a stale/idle login screen before rechecking.
const LOGIN_TIMEOUT_MS = parseInt(process.env.LOGIN_QUEUE_TIMEOUT_MS || String(10 * 60 * 1000), 10);
// Amazon, Walmart, Costco and BFMR are all always queued: a dead session on
// any of them must get its login window opened without depending on an opt-in
// Setting that nothing in the app can turn on.
const ALWAYS_SITES = ['amazon', 'walmart', 'costco', 'bfmr'];

function isEnabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

function activeSites(statuses) {
  return [...ALWAYS_SITES.filter(s => loginFlow.SITE_CONFIG[s])];
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// A site "needs login" if it has no saved session at all (ground truth:
// the local file, same check poll.js's handleCommand uses to fail fast)
// OR the tracker's own status says the last real sync attempt hit an
// expired session. hasSession() alone can't distinguish "expired" from
// "never tried"; remote status alone can't distinguish "genuinely never
// logged in" from "file exists but the tracker hasn't been told yet"
// (e.g. right after this container's very first boot).
async function sitesNeedingLogin() {
  let statuses = {};
  try {
    statuses = await getSettings();
  } catch (e) {
    console.warn('[login-queue] could not fetch settings, using local session-file check only:', e.message);
  }
  return activeSites(statuses).filter(site => {
    if (!hasSession(site)) return true;
    return statuses[`${site}_session_status`] === 'expired';
  });
}

let cycleCount = 0;

async function runQueueOnce() {
  const needing = await sitesNeedingLogin();
  if (needing.length === 0) return;

  // Rotate starting order each cycle so one persistently-failing site
  // (e.g. an account that needs real manual attention) can't starve the
  // other of a turn on the display forever.
  const ordered = cycleCount % 2 === 0 ? needing : [...needing].reverse();
  cycleCount++;

  console.log(`[login-queue] sites needing login: ${ordered.join(', ')}`);

  // Queue-based loop that re-evaluates which sites need login between sites.
  const queue = [...ordered];
  const visited = new Set();

  function pushNewlyNeedy(fresh) {
    for (const s of fresh) {
      if (!visited.has(s) && !queue.includes(s)) {
        console.log(`[login-queue] ${s} became needy — added to queue`);
        queue.push(s);
      }
    }
  }

  while (queue.length > 0) {
    const site = queue.shift();
    if (visited.has(site)) continue;
    visited.add(site);

    // Re-evaluate: has this site's status changed?
    const fresh = await sitesNeedingLogin();
    pushNewlyNeedy(fresh);
    if (!fresh.includes(site)) {
      console.log(`[login-queue] ${site} no longer needs login — skipping`);
      continue;
    }

    // Open the site's window (acquireBrowserLock / launchBrowser / waitForLogin)
    let release, browser, context;
    try {
      try { release = await acquireBrowserLock('login', { site, waitMs: 0 }); }
      catch (e) {
        if (e instanceof BrowserBusyError) {
          console.log(`[login-queue] ${site} skipped: ${e.message}`);
          continue; // already in visited — won't re-push this site
        }
        throw e;
      }

      browser = await launchBrowser();
      context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const prepare = loginFlow.SITE_CONFIG[site].prepareContext;
      if (prepare) await prepare(context);
      const page = await context.newPage();

      console.log(`[login-queue] opening ${site} login page — connect VNC to complete it (retries after ~${Math.round(LOGIN_TIMEOUT_MS / 60000)} min if idle)`);
      const loggedIn = await loginFlow.waitForLogin(site, page, { timeoutMs: LOGIN_TIMEOUT_MS, context });

      if (loggedIn) {
        console.log(`[login-queue] ${site} login completed and saved.`);
      } else {
        console.log(`[login-queue] ${site} login not completed within the window — will retry next cycle.`);
      }
    } catch (e) {
      console.error(`[login-queue] ${site} login attempt failed:`, e.message);
    } finally {
      if (release) await release();
      if (context) await context.close().catch(() => {});
      if (browser) await browser.close().catch(() => {});

      // After finishing, re-evaluate fresh again and push any newly needy unvisited sites.
      const postFresh = await sitesNeedingLogin();
      for (const s of postFresh) {
        if (!visited.has(s)) queue.push(s);
      }
    }
  }
}

async function main() {
  console.log(`[login-queue] starting, check interval=${CHECK_INTERVAL_MS}ms, per-site timeout=${LOGIN_TIMEOUT_MS}ms`);
  for (;;) {
    await runQueueOnce().catch(e => console.error('[login-queue] loop error:', e));
    await sleep(CHECK_INTERVAL_MS);
  }
}

module.exports = { sitesNeedingLogin, runQueueOnce, activeSites, isEnabled };

if (require.main === module) {
  main();
}
