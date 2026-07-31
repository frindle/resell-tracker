'use strict';

// Polls the SAME ExtensionCommand queue the browser extension polls
// (GET /api/extension/commands, PATCH /api/extension/commands/:id) —
// this is a drop-in alternative trigger path, not a parallel system.
// Untargeted SYNC_AMAZON/SYNC_WALMART commands queued from the Orders
// page get claimed by whichever poller (real extension or this sidecar)
// asks first.
//
// ponytail: no claim/lock beyond the existing `status` field, so if both
// the real extension AND this sidecar are polling at the same moment
// there's a small race where both could pick up the same pending
// command. /api/import's create-or-update-by-order-number logic makes a
// double-run harmless (idempotent), so this isn't worth a locking scheme
// unless it's observed causing real duplicate work.

const {
  getSettings, setSettings, fetchCommands, patchCommand, pushOrders,
  logApiError, captureFailure, launchBrowser, newContextForSite,
  SessionExpiredError, hasSession,
} = require('./lib');
const { syncAmazon } = require('./amazon');
const { syncWalmart } = require('./walmart');

const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '60000', 10);

const SITES = {
  SYNC_AMAZON: { site: 'amazon', run: syncAmazon, lastSyncKey: 'amazon_sidecar_last_sync' },
  SYNC_WALMART: { site: 'walmart', run: syncWalmart, lastSyncKey: 'walmart_sidecar_last_sync' },
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function handleCommand(cmd) {
  const cfg = SITES[cmd.type];
  const { site, run, lastSyncKey } = cfg;
  console.log(`[poll] claiming command #${cmd.id} (${cmd.type})`);
  await patchCommand(cmd.id, 'running');

  if (!hasSession(site)) {
    const msg = `no saved ${site} session — run the one-time interactive login (node src/login.js ${site})`;
    console.error(`[poll] ${msg}`);
    await patchCommand(cmd.id, 'failed', { error: msg });
    await setSettings({ [`${site}_session_status`]: 'never_logged_in' });
    await logApiError({ group: site === 'amazon' ? 'Amazon' : 'Walmart', endpoint: cmd.type, context: msg });
    return;
  }

  let browser, context;
  try {
    browser = await launchBrowser();
    context = await newContextForSite(browser, site);
    const page = await context.newPage();
    page.on('pageerror', e => console.error(`[${site}] pageerror:`, e.message));
    page.on('console', msg => {
      // Forward the ported script's own console.log/warn/error so the
      // scrape transcript lands in `docker logs`, same intent as the
      // extension's SCRAPE_LOG forwarding to the background page.
      if (['warning', 'error'].includes(msg.type())) console.log(`[${site}/page:${msg.type()}]`, msg.text());
    });

    const settings = await getSettings();
    const orders = await run(page, { lastSyncIso: settings[lastSyncKey] || null });

    let result = { imported: 0, updated: 0, skipped: 0 };
    if (orders.length > 0) {
      result = await pushOrders(orders);
    }
    console.log(`[poll] ${site} sync done: scraped=${orders.length}`, result);

    await setSettings({
      [lastSyncKey]: new Date().toISOString().split('T')[0],
      [`${site}_session_status`]: 'active',
      [`${site}_session_checked_at`]: new Date().toISOString(),
    });
    await patchCommand(cmd.id, 'done', { platform: site === 'amazon' ? 'Amazon' : 'Walmart', scraped: orders.length, ...result });
  } catch (err) {
    const isExpired = err instanceof SessionExpiredError;
    console.error(`[poll] ${site} sync FAILED:`, err.message);
    let debug = {};
    try {
      const page = context ? (await context.pages())[0] : null;
      if (page) debug = await captureFailure(page, site, isExpired ? 'session-expired' : 'sync-failed');
    } catch { /* best effort */ }

    await patchCommand(cmd.id, 'failed', { error: err.message, ...debug });
    await setSettings({
      [`${site}_session_status`]: isExpired ? 'expired' : 'active',
      [`${site}_session_checked_at`]: new Date().toISOString(),
    });
    await logApiError({
      group: site === 'amazon' ? 'Amazon' : 'Walmart',
      endpoint: cmd.type,
      context: isExpired
        ? `Session expired — re-run the interactive login (docker exec -it <container> node src/login.js ${site})`
        : `Sync failed: ${err.message}`,
      body: JSON.stringify(debug),
    });
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

async function pollOnce() {
  let commands;
  try {
    commands = await fetchCommands();
  } catch (e) {
    console.error('[poll] failed to fetch commands:', e.message);
    return;
  }
  const pending = commands.filter(c => c.status === 'pending' && SITES[c.type]);
  for (const cmd of pending) {
    // Sequential — two browser launches at once on one container is
    // unnecessary complexity for a background job with no latency SLA.
    await handleCommand(cmd);
  }
}

async function main() {
  console.log(`[poll] starting, interval=${POLL_INTERVAL_MS}ms, tracker=${process.env.TRACKER_URL}`);
  for (;;) {
    await pollOnce().catch(e => console.error('[poll] loop error:', e));
    await sleep(POLL_INTERVAL_MS);
  }
}

main();
