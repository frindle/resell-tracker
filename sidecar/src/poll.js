'use strict';

// Polls the SAME ExtensionCommand queue the browser extension polls
// (GET /api/extension/commands, PATCH /api/extension/commands/:id) —
// this is a drop-in alternative trigger path, not a parallel system.
// Untargeted commands queued from the app get claimed by whichever
// poller (real extension or this sidecar) asks first. See the SITES map
// below for the types this sidecar can claim; anything else it leaves
// pending for the extension (pollOnce filters on SITES membership).
//
// ponytail: no claim/lock beyond the existing `status` field, so if both
// the real extension AND this sidecar are polling at the same moment
// there's a small race where both could pick up the same pending
// command. /api/import's create-or-update-by-order-number logic makes a
// double-run harmless (idempotent), so this isn't worth a locking scheme
// unless it's observed causing real duplicate work.

const {
  getSettings, setSettings, fetchCommands, patchCommand, pushOrders,
  pushCostcoReceipts, pushPortalRates, fetchBfmrVendors,
  fetchMissingTrackingOrderNumbers, queueCommand,
  logApiError, captureFailure, launchBrowser, newContextForSite,
  SessionExpiredError, hasSession, refreshVncPasswordFile,
} = require('./lib');
const { syncAmazon, syncAmazonOrders } = require('./amazon');
const { syncWalmart } = require('./walmart');
const { syncCostco, installInterceptor: installCostcoInterceptor } = require('./costco');
const { scrapeCashbackMonitor } = require('./cashbackmonitor');
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

// Command types this sidecar can execute. Two shapes:
//   kind:'site'        — needs a saved logged-in session for `site`, runs
//                        a scrape against it, pushes the result rows.
//   kind:'sessionless' — no retailer session involved at all (CBM store
//                        pages are public), so it gets a clean context.
//
// Every type here is one the browser extension also claims off the same
// queue (background/index.ts pollAndExecuteCommands). Whichever poller
// asks first wins; see the race note at the top of this file.
const SITES = {
  SYNC_AMAZON: {
    kind: 'site', site: 'amazon', platform: 'Amazon',
    run: (page, ctx) => syncAmazon(page, ctx),
    lastSyncKey: 'amazon_sidecar_last_sync',
  },
  SYNC_WALMART: {
    kind: 'site', site: 'walmart', platform: 'Walmart',
    run: (page, ctx) => syncWalmart(page, ctx),
    lastSyncKey: 'walmart_sidecar_last_sync',
  },
  SYNC_COSTCO: {
    kind: 'site', site: 'costco', platform: 'Costco',
    // The auth token only exists on Costco's own in-page requests, so the
    // interceptor has to be installed on the context before the first
    // navigation — see costco.js's module header.
    prepareContext: installCostcoInterceptor,
    run: (page, ctx) => syncCostco(page, ctx),
    lastSyncKey: 'costco_sidecar_last_sync',
  },
  SYNC_AMAZON_ORDER: {
    kind: 'site', site: 'amazon', platform: 'Amazon',
    // Targeted refresh of specific orders — not a time-windowed sweep, so
    // it must NOT advance amazon_sidecar_last_sync or the next full sync
    // would skip the window this run never looked at.
    lastSyncKey: null,
    run: (page, ctx) => syncAmazonOrders(page, ctx.payload && ctx.payload.orderNumbers),
  },
  SCRAPE_CBM: {
    kind: 'sessionless', platform: 'CBM',
    run: (page, ctx) => runCbm(page, ctx),
  },
};

// A full sync's command type -> the targeted per-order type to self-
// dispatch a follow-up on, for orders the full sync just ran over that
// still came out with no tracking number. Only Amazon has a targeted
// type built (SYNC_AMAZON_ORDER) -- Walmart and Costco don't yet, so
// they're simply absent here rather than wired to something that
// doesn't exist. Add an entry once a matching *_ORDER type exists for
// either.
const BACKFILL_TARGET_TYPE = {
  SYNC_AMAZON: 'SYNC_AMAZON_ORDER',
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

function parsePayload(cmd) {
  if (!cmd.payload) return null;
  try {
    return typeof cmd.payload === 'string' ? JSON.parse(cmd.payload) : cmd.payload;
  } catch (e) {
    console.warn(`[poll] command #${cmd.id} has unparseable payload, ignoring: ${e.message}`);
    return null;
  }
}

// SCRAPE_CBM: merchant list comes from the command payload (a bare array,
// same as the extension sent) or falls back to /api/bfmr/vendors.
async function runCbm(page, { payload }) {
  let merchants = Array.isArray(payload) ? payload
    : (payload && Array.isArray(payload.merchants)) ? payload.merchants
      : [];
  if (merchants.length === 0) {
    merchants = await fetchBfmrVendors().catch(e => {
      console.warn('[cbm] vendor list fetch failed:', e.message);
      return [];
    });
  }
  if (merchants.length === 0) return { skipped: true, reason: 'no merchants' };

  console.log(`[cbm] scraping ${merchants.length} merchant(s)`);
  const { entries, results } = await scrapeCashbackMonitor(page, merchants);
  let upserted = 0;
  if (entries.length > 0) {
    const res = await pushPortalRates(entries);
    upserted = (res && res.upserted) || 0;
  }
  return { merchants: results, upserted };
}

async function handleCommand(cmd) {
  const cfg = SITES[cmd.type];
  console.log(`[poll] claiming command #${cmd.id} (${cmd.type})`);
  await patchCommand(cmd.id, 'running');
  const payload = parsePayload(cmd);

  if (cfg.kind === 'sessionless') {
    await handleSessionlessCommand(cmd, cfg, payload);
    return;
  }

  const { site, run, lastSyncKey } = cfg;

  if (!hasSession(site)) {
    const msg = `no saved ${site} session — run the one-time interactive login (node src/login.js ${site})`;
    console.error(`[poll] ${msg}`);
    await patchCommand(cmd.id, 'failed', { error: msg });
    await setSettings({ [`${site}_session_status`]: 'never_logged_in' });
    await logApiError({ group: cfg.platform, endpoint: cmd.type, context: msg });
    return;
  }

  let browser, context;
  try {
    browser = await launchBrowser();
    context = await newContextForSite(browser, site);
    if (cfg.prepareContext) await cfg.prepareContext(context);
    const page = await context.newPage();
    page.on('pageerror', e => console.error(`[${site}] pageerror:`, e.message));
    page.on('console', msg => {
      // Forward the ported script's own console.log/warn/error so the
      // scrape transcript lands in `docker logs`, same intent as the
      // extension's SCRAPE_LOG forwarding to the background page.
      if (['warning', 'error'].includes(msg.type())) console.log(`[${site}/page:${msg.type()}]`, msg.text());
    });

    const settings = await getSettings();
    const out = await run(page, {
      lastSyncIso: lastSyncKey ? (settings[lastSyncKey] || null) : null,
      payload,
    });

    // Runs return either a bare orders array (amazon/walmart) or an
    // object that may also carry other sinks (costco's warehouse
    // receipts). Normalise both here so each scraper stays focused on
    // scraping and only this loop knows about the tracker's endpoints.
    const orders = Array.isArray(out) ? out : (out.orders || []);
    const receipts = Array.isArray(out) ? [] : (out.receipts || []);

    let result = { imported: 0, updated: 0, skipped: 0 };
    if (orders.length > 0) {
      result = await pushOrders(orders);
    }

    let receiptResult;
    if (receipts.length > 0) {
      // Non-fatal, exactly as in the extension: a receipt-push failure
      // must not discard an otherwise successful order import.
      try {
        receiptResult = await pushCostcoReceipts(receipts);
        console.log(`[poll] ${site} receipts pushed:`, receiptResult);
      } catch (e) {
        console.error(`[poll] ${site} receipt push failed (non-fatal):`, e.message);
      }
    }
    console.log(`[poll] ${site} sync done: scraped=${orders.length}`, result);

    await setSettings({
      ...(lastSyncKey ? { [lastSyncKey]: new Date().toISOString().split('T')[0] } : {}),
      [`${site}_session_status`]: 'active',
      [`${site}_session_checked_at`]: new Date().toISOString(),
    });
    await patchCommand(cmd.id, 'done', {
      platform: cfg.platform,
      scraped: orders.length,
      ...result,
      ...(receiptResult ? { receiptsLinked: receiptResult.linked, receiptsUnlinked: receiptResult.unlinked } : {}),
    });

    // Right after a full sync, not on a targeted one -- BACKFILL_TARGET_TYPE
    // is only keyed by the full-sync types, so this can't recurse into
    // itself. Best-effort: a failure here doesn't touch the sync's own
    // already-reported result.
    const backfillType = BACKFILL_TARGET_TYPE[cmd.type];
    if (backfillType) {
      try {
        const missing = await fetchMissingTrackingOrderNumbers(cfg.platform);
        if (missing.length > 0) {
          console.log(`[poll] ${site}: ${missing.length} order(s) still missing tracking after full sync, dispatching ${backfillType}`);
          await queueCommand(backfillType, { orderNumbers: missing });
        }
      } catch (e) {
        console.warn(`[poll] ${site}: backfill dispatch failed (non-fatal):`, e.message);
      }
    }
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
      group: cfg.platform,
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

// No retailer session, no storageState, no *_session_status bookkeeping —
// a clean throwaway context so nothing this browser is logged into leaks
// to a third-party site.
async function handleSessionlessCommand(cmd, cfg, payload) {
  let browser, context;
  try {
    browser = await launchBrowser();
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.on('pageerror', e => console.error(`[${cfg.platform}] pageerror:`, e.message));

    const result = await cfg.run(page, { payload });
    console.log(`[poll] ${cmd.type} done:`, JSON.stringify(result).slice(0, 300));
    await patchCommand(cmd.id, 'done', result);
  } catch (err) {
    console.error(`[poll] ${cmd.type} FAILED:`, err.message);
    let debug = {};
    try {
      const page = context ? (await context.pages())[0] : null;
      if (page) debug = await captureFailure(page, cfg.platform.toLowerCase(), 'sync-failed');
    } catch { /* best effort */ }
    await patchCommand(cmd.id, 'failed', { error: err.message, ...debug });
    await logApiError({
      group: cfg.platform,
      endpoint: cmd.type,
      context: `Sync failed: ${err.message}`,
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
