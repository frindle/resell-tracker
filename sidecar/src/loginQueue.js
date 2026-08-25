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

const { hasSession, getSettings, launchBrowser } = require('./lib');
const { waitForLogin, SITE_CONFIG } = require('./loginFlow');

const CHECK_INTERVAL_MS = parseInt(process.env.LOGIN_QUEUE_CHECK_MS || '30000', 10);
// Shorter than login.js's interactive 30-min default -- this runs
// unattended and just retries after every timeout, so a shorter window
// means less time showing a stale/idle login screen before rechecking.
const LOGIN_TIMEOUT_MS = parseInt(process.env.LOGIN_QUEUE_TIMEOUT_MS || String(10 * 60 * 1000), 10);
// Amazon and Walmart are always queued. Costco is opt-in: there is one
// shared X11 display, so an unused site sitting on its login page would
// occupy the VNC session and starve the sites that DO need attention.
// The opt-in is the costco_sidecar_enabled Setting (any of the usual
// truthy spellings), set from the app's Settings page.
const ALWAYS_SITES = ['amazon', 'walmart'];
const OPT_IN_SITES = { costco: 'costco_sidecar_enabled' };

function isEnabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

function activeSites(statuses) {
  const extra = Object.entries(OPT_IN_SITES)
    .filter(([site, key]) => SITE_CONFIG[site] && isEnabled(statuses[key]))
    .map(([site]) => site);
  return [...ALWAYS_SITES.filter(s => SITE_CONFIG[s]), ...extra];
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
  for (const site of ordered) {
    console.log(`[login-queue] opening ${site} login page — connect VNC to complete it (retries after ~${Math.round(LOGIN_TIMEOUT_MS / 60000)} min if idle)`);
    let browser, context;
    try {
      browser = await launchBrowser();
      context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const prepare = SITE_CONFIG[site].prepareContext;
      if (prepare) await prepare(context);
      const page = await context.newPage();
      const loggedIn = await waitForLogin(site, page, { timeoutMs: LOGIN_TIMEOUT_MS, context });
      if (loggedIn) {
        console.log(`[login-queue] ${site} login completed and saved.`);
      } else {
        console.log(`[login-queue] ${site} login not completed within the window — will retry next cycle.`);
      }
    } catch (e) {
      console.error(`[login-queue] ${site} login attempt failed:`, e.message);
    } finally {
      if (context) await context.close().catch(() => {});
      if (browser) await browser.close().catch(() => {});
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

module.exports = { sitesNeedingLogin, runQueueOnce };

if (require.main === module) {
  main();
}
