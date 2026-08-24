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
  SessionExpiredError, hasSession, refreshVncPasswordFile,
} = require('./lib');
const { syncAmazon, syncAmazonOrders } = require('./amazon');
const { syncWalmart } = require('./walmart');
const { syncCostco } = require('./costco');
const http = require('http');

const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '60000', 10);
const REFRESH_PORT = parseInt(process.env.VNC_REFRESH_PORT || '6081', 10);
const SIDECAR_SHARED_SECRET = process.env.SIDECAR_SHARED_SECRET || '';

// Pushed to immediately by app/api/settings/route.ts right after a
// vnc_password save, so a new password takes effect within the same
// request/response cycle instead of waiting on a poll interval. The
// VNC_REFRESH_INTERVAL_MS loop below is a fallback safety net only, for
// the case where the push itself fails (network blip, app mid-restart).
function startVncRefreshServer() {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/refresh-vnc-password') {
      res.writeHead(404).end();
      return;
    }
    if (!SIDECAR_SHARED_SECRET || req.headers['x-sidecar-secret'] !== SIDECAR_SHARED_SECRET) {
      res.writeHead(401).end();
      return;
    }
    refreshVncPasswordFile()
      .then(result => {
        console.log('[vnc-refresh] pushed refresh:', result);
        res.writeHead(result.ok ? 200 : 500, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
      })
      .catch(e => {
        console.error('[vnc-refresh] pushed refresh failed:', e.message);
        res.writeHead(500).end();
      });
  });
  server.listen(REFRESH_PORT, () => console.log(`[vnc-refresh] listening on :${REFRESH_PORT}`));
}

const VNC_REFRESH_FALLBACK_MS = parseInt(process.env.VNC_REFRESH_FALLBACK_MS || '60000', 10);
async function vncRefreshFallbackLoop() {
  for (;;) {
    await sleep(VNC_REFRESH_FALLBACK_MS);
    try {
      const result = await refreshVncPasswordFile();
      if (!result.ok) console.log('[vnc-refresh] fallback poll skipped:', result.reason);
    } catch (e) {
      console.error('[vnc-refresh] fallback poll failed:', e.message);
    }
  }
}

// lastSyncKey null = this command type doesn't advance the incremental
// sync watermark. SYNC_AMAZON_ORDER is a targeted re-scrape of specific
// order numbers (queued by /api/bfmr/sync-orders), so it says nothing
// about how far the *list* walk has gotten — writing the watermark from
// it would make the next SYNC_AMAZON skip everything between.
const SITES = {
  SYNC_AMAZON: { site: 'amazon', label: 'Amazon', run: syncAmazon, lastSyncKey: 'amazon_sidecar_last_sync' },
  SYNC_WALMART: { site: 'walmart', label: 'Walmart', run: syncWalmart, lastSyncKey: 'walmart_sidecar_last_sync' },
  SYNC_COSTCO: { site: 'costco', label: 'Costco', run: syncCostco, lastSyncKey: 'costco_sidecar_last_sync' },
  SYNC_AMAZON_ORDER: { site: 'amazon', label: 'Amazon', run: syncAmazonOrders, lastSyncKey: null, usesPayload: true },
};

// SYNC_AMAZON_ORDER carries {orderNumbers:[...]} as a JSON string in
// ExtensionCommand.payload; every other type ignores it.
function parseCommandPayload(cmd) {
  if (!cmd.payload) return {};
  try {
    const parsed = JSON.parse(cmd.payload);
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch {
    console.warn(`[poll] command #${cmd.id}: unparseable payload, ignoring`);
    return {};
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function handleCommand(cmd) {
  const cfg = SITES[cmd.type];
  const { site, label, run, lastSyncKey } = cfg;
  console.log(`[poll] claiming command #${cmd.id} (${cmd.type})`);
  await patchCommand(cmd.id, 'running');

  if (!hasSession(site)) {
    const msg = `no saved ${site} session — run the one-time interactive login (node src/login.js ${site})`;
    console.error(`[poll] ${msg}`);
    await patchCommand(cmd.id, 'failed', { error: msg });
    await setSettings({ [`${site}_session_status`]: 'never_logged_in' });
    await logApiError({ group: label, endpoint: cmd.type, context: msg });
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
    const orders = await run(page, {
      lastSyncIso: lastSyncKey ? (settings[lastSyncKey] || null) : null,
      ...(cfg.usesPayload ? parseCommandPayload(cmd) : {}),
    });

    let result = { imported: 0, updated: 0, skipped: 0 };
    if (orders.length > 0) {
      result = await pushOrders(orders);
    }
    console.log(`[poll] ${site} sync done: scraped=${orders.length}`, result);

    await setSettings({
      ...(lastSyncKey ? { [lastSyncKey]: new Date().toISOString().split('T')[0] } : {}),
      [`${site}_session_status`]: 'active',
      [`${site}_session_checked_at`]: new Date().toISOString(),
    });
    await patchCommand(cmd.id, 'done', { platform: label, scraped: orders.length, ...result });
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
      group: label,
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
  startVncRefreshServer();
  vncRefreshFallbackLoop().catch(e => console.error('[vnc-refresh] fallback loop crashed:', e));
  for (;;) {
    await pollOnce().catch(e => console.error('[poll] loop error:', e));
    await sleep(POLL_INTERVAL_MS);
  }
}

main();
