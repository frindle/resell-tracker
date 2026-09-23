'use strict';

// The single decision for what a Walmart order's trackingNumbers become after
// a detail-page scrape, so a fabricated order-number placeholder can never be
// confused with -- or block -- a later real carrier tracking number.
//
// Background: commit 82b8fc1 deleted the `isStoreDelivery` gate in walmart.js;
// the fallback `order.trackingNumbers = [order.orderNumber.replace(/[^0-9]/g, "")]`
// then fired unconditionally whenever no carrier tracking was scraped --
// including on orders that had not shipped yet and would later ship UPS or
// FedEx. That fabricated value is TERMINAL downstream: push-tracking selects
// every order with non-null trackingNumbers and submits it to BFMR, and
// submitTracking() skips rows that already have a number set, so a real
// carrier number can never replace it afterwards. The fix is WHEN the
// placeholder is produced (only for a DELIVERED store delivery) plus an
// explicit `fabricated` flag; its VALUE format stays digits-only order number,
// which app/api/import/route.ts's isValidTracking and the BFMR submit path
// already encode.

// Walmart-internal reference ids that are never real carrier tracking.
const WALMART_INTERNAL_TRACKING_RE = /^555\d{15,}$/;

/**
 * True when `value` is a fabricated order-number placeholder for
 * `orderNumber`: both non-empty and value's digits-only form equals the
 * order number's digits-only form. Mirrors app/api/import/route.ts's
 * isOrderNumberTracking so downstream and scraper agree on what a
 * placeholder looks like.
 *
 * @param {string|number|null|undefined} value
 * @param {string|null|undefined} orderNumber
 * @returns {boolean}
 */
function isFabricatedOrderNumberTracking(value, orderNumber) {
  if (!value || !orderNumber) return false;
  const vNorm = String(value).replace(/\D/g, '');
  const oNorm = String(orderNumber).replace(/\D/g, '');
  return vNorm.length > 0 && vNorm === oNorm;
}

/**
 * Decide what a Walmart order's trackingNumbers become after a detail-page
 * scrape. Pure: no clock read, no network, no DB, no require().
 *
 * Decision order (top to bottom):
 *   1. Filter scrapedTracking: drop falsy/blank values, any value that is a
 *      fabricated order-number placeholder for this order, and any
 *      Walmart-internal reference id.
 *   2. Anything survives -> real carrier tracking; it ALWAYS wins and is
 *      never suppressed by any other flag.
 *   3. No order number -> null (nothing to fabricate from).
 *   4. Not a store delivery -> null: the order may still ship by carrier, so
 *      'no tracking scraped on this pass' must not be treated as terminal.
 *   5. Store delivery but not yet delivered -> null: it can still be
 *      re-routed to UPS/FedEx before delivery.
 *   6. Delivered store delivery -> the digits-only order number, flagged
 *      fabricated (the only path that invents anything).
 *
 * @param {object} opts
 * @param {string|null|undefined} [opts.orderNumber]
 * @param {Array<string>|null|undefined} [opts.scrapedTracking] raw strings from the detail page
 * @param {boolean} [opts.isStoreDelivery]
 * @param {boolean} [opts.isDelivered]
 * @returns {{ trackingNumbers: string[] | null, fabricated: boolean, reason: 'carrier'|'not-store-delivery'|'store-delivery-pending'|'store-delivery-final'|'no-order-number' }}
 */
function resolveWalmartTracking({ orderNumber, scrapedTracking, isStoreDelivery, isDelivered } = {}) {
  const survivors = (scrapedTracking || []).filter(
    (t) =>
      t &&
      String(t).trim() !== '' &&
      !isFabricatedOrderNumberTracking(t, orderNumber) &&
      !WALMART_INTERNAL_TRACKING_RE.test(String(t))
  );

  if (survivors.length > 0) {
    return { trackingNumbers: survivors, fabricated: false, reason: 'carrier' };
  }

  if (!orderNumber || String(orderNumber).trim() === '') {
    return { trackingNumbers: null, fabricated: false, reason: 'no-order-number' };
  }

  // The restored gate: an order that is not a store delivery may still ship
  // by carrier, so never invent tracking for it.
  if (isStoreDelivery !== true) {
    return { trackingNumbers: null, fabricated: false, reason: 'not-store-delivery' };
  }

  // A store delivery can still be re-routed to UPS/FedEx before it is
  // delivered, so 'no tracking scraped on this pass' is NOT a terminal state.
  if (isDelivered !== true) {
    return { trackingNumbers: null, fabricated: false, reason: 'store-delivery-pending' };
  }

  return {
    trackingNumbers: [String(orderNumber).replace(/\D/g, '')],
    fabricated: true,
    reason: 'store-delivery-final',
  };
}

module.exports = { resolveWalmartTracking, isFabricatedOrderNumberTracking, WALMART_INTERNAL_TRACKING_RE };
