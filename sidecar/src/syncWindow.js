'use strict';

// How far back a sync looks, by ORDER PLACED date.
//
// Every scraper here walks the retailer's order list newest-first and stops
// as soon as it sees an order placed before this date. That is the right
// shape for finding NEW orders and the wrong shape for noticing that an OLD
// order has changed -- and tracking numbers are exactly that: they appear
// days after the order was placed, on an order the tracker already has.
//
// The bug this exists to prevent: `lastSync` is stamped with today's date
// after every successful run, so an incremental window of "lastSync minus a
// day's overlap" is about 48 hours wide. An order placed on the 20th that
// ships on the 27th is outside every sync between those dates, so its
// tracking number is never picked up. Orders that ship within a day of being
// placed sail through, which is why this reads as "some orders got their
// shipping info and one didn't" rather than as a broken sync.
//
// So the window has a floor: however recent the last sync was, always look
// back at least `minLookbackDays`, which is the window in which an order can
// still acquire a tracking number. It costs one detail fetch per order in
// that window per sync (DETAIL_FETCH_DELAY_MS apart), so it is a real
// throughput trade and the floor is deliberately measured in days, not
// months. A long-delayed shipment past the floor still needs a targeted
// re-scrape (SYNC_AMAZON_ORDER).

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {object}  opts
 * @param {string?} opts.lastSyncIso   watermark from settings ("YYYY-MM-DD" or a full ISO stamp)
 * @param {number}  opts.coldStartDays how far back to go when there is no watermark at all
 * @param {number}  opts.minLookbackDays never look back less far than this
 * @param {number} [opts.overlapMs]    slack subtracted from the watermark, to cover a run that
 *                                     scraped mid-day; defaults to one day
 * @param {Date}   [opts.now]
 * @returns {Date}
 */
function computeSinceDate({ lastSyncIso, coldStartDays, minLookbackDays, overlapMs = DAY_MS, now = new Date() }) {
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  const last = lastSyncIso ? new Date(lastSyncIso) : null;
  if (!last || isNaN(last.getTime())) return new Date(nowMs - coldStartDays * DAY_MS);

  // Whichever reaches further back: the incremental window, or the floor. A
  // sidecar that has been off for months keeps its own much older watermark
  // rather than being pulled forward to the floor and silently skipping
  // everything in between.
  return new Date(Math.min(last.getTime() - overlapMs, nowMs - minLookbackDays * DAY_MS));
}

/**
 * Reads a lookback floor from the environment, so it can be tuned per
 * deployment without a rebuild. Anything unparseable or negative falls back
 * to the default rather than producing a window of NaN, which the scrapers'
 * string date comparison would silently turn into "scrape nothing".
 */
/**
 * @param {string} name
 * @param {number} fallback
 * @param {Record<string, string | undefined>} [env]
 * @returns {number}
 */
function lookbackDaysFromEnv(name, fallback, env = process.env) {
  const raw = env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

// --- Amazon -------------------------------------------------------------
// Cold start matches the extension's 60 days. The floor is how long an order
// stays eligible to have a late-arriving tracking number noticed; raise
// AMAZON_SYNC_LOOKBACK_DAYS if orders routinely ship later than that, at the
// cost of one detail fetch per in-window order per sync.
const AMAZON_COLD_START_DAYS = 60;
const AMAZON_MIN_LOOKBACK_DAYS = lookbackDaysFromEnv('AMAZON_SYNC_LOOKBACK_DAYS', 14);

function computeAmazonSinceDate(lastSyncIso, now = new Date(), minLookbackDays = AMAZON_MIN_LOOKBACK_DAYS) {
  return computeSinceDate({
    lastSyncIso,
    coldStartDays: AMAZON_COLD_START_DAYS,
    minLookbackDays,
    now,
  });
}

module.exports = {
  computeSinceDate,
  computeAmazonSinceDate,
  lookbackDaysFromEnv,
  AMAZON_COLD_START_DAYS,
  AMAZON_MIN_LOOKBACK_DAYS,
  DAY_MS,
};
