#!/usr/bin/env python3
"""Reference impl for: rt-walmart-store-tracking-gate

The gate applies this, runs the verify, and reverts it. It proves two things at
once: the task is SATISFIABLE as specified, and the verify actually ENFORCES the
spec (a refimpl that goes green while a "Must contain" literal is absent means
the verify is benign).

sidecar/src/walmartTracking.js is a NEW file for this dispatch (creation_task),
so the reference impl writes it whole. The JS block below is RAW: the regexes
contain backslashes that must survive verbatim into the emitted source.
"""
import pathlib
import sys

wt = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
p = wt / 'sidecar/src/walmartTracking.js'
p.parent.mkdir(parents=True, exist_ok=True)

NEW = r'''// The single decision for what a Walmart order's trackingNumbers become after
// a detail-page scrape.
//
// Why this exists: commit 82b8fc1 deleted the isStoreDelivery gate in
// walmart.js, so `order.trackingNumbers = [order.orderNumber.replace(/[^0-9]/g, "")]`
// fired unconditionally whenever no carrier tracking was scraped -- including on
// orders that have not shipped yet and will later ship UPS or FedEx. That value
// is TERMINAL downstream: app/api/bfmr/push-tracking/route.ts submits every order
// with non-null trackingNumbers to BFMR, and submitTracking() skips rows that
// already have a number set, so a real carrier number can never replace it.
// The decision must therefore refuse to fabricate anything for an order that
// could still ship by carrier: only a DELIVERED store delivery -- which by
// definition will never get a carrier number -- gets the placeholder.
//
// Dependency-free CommonJS (no require()), exactly like syncWindow.js, so
// lib/*.test.ts can default-import it under node --experimental-strip-types.

'use strict';

// Walmart-internal reference ids that are never real carrier tracking.
const WALMART_INTERNAL_TRACKING_RE = /^555\d{15,}$/;

function digitsOnly(value) {
  return String(value).replace(/[^0-9]/g, '');
}

/**
 * True when `value` is a fabricated order-number placeholder for this order:
 * both non-empty and equal once reduced to digits only (dashes/letters aside).
 * Mirrors app/api/import/route.ts's isOrderNumberTracking so the scraper and
 * downstream agree on what a placeholder looks like.
 */
function isFabricatedOrderNumberTracking(value, orderNumber) {
  if (!value || !orderNumber) return false;
  const v = digitsOnly(value);
  const o = digitsOnly(orderNumber);
  return v.length > 0 && v === o;
}

/**
 * @param {object} opts
 * @param {string?} opts.orderNumber
 * @param {Array<string>?} opts.scrapedTracking raw strings from the detail page (may be empty/undefined)
 * @param {boolean?} opts.isStoreDelivery
 * @param {boolean?} opts.isDelivered
 * @returns {{ trackingNumbers: string[] | null, fabricated: boolean, reason: 'carrier' | 'not-store-delivery' | 'store-delivery-pending' | 'store-delivery-final' | 'no-order-number' }}
 */
function resolveWalmartTracking({ orderNumber, scrapedTracking, isStoreDelivery, isDelivered } = {}) {
  // 1. Filter: drop falsy/blank values, fabricated order-number placeholders,
  //    and Walmart-internal reference ids.
  const survivors = (scrapedTracking || []).filter(
    (value) => value && String(value).trim() !== ''
      && !isFabricatedOrderNumberTracking(String(value), orderNumber)
      && !WALMART_INTERNAL_TRACKING_RE.test(String(value)),
  );

  // 2. Real carrier tracking ALWAYS wins and is never suppressed by any flag.
  if (survivors.length > 0) {
    return { trackingNumbers: survivors, fabricated: false, reason: 'carrier' };
  }

  // 3. Nothing to fabricate from.
  if (!orderNumber || String(orderNumber).trim() === '') {
    return { trackingNumbers: null, fabricated: false, reason: 'no-order-number' };
  }

  // 4. The restored gate: a non-store-delivery order may still ship by carrier,
  //    so never invent tracking for it.
  if (isStoreDelivery !== true) {
    return { trackingNumbers: null, fabricated: false, reason: 'not-store-delivery' };
  }

  // 5. A store delivery can still be re-routed to UPS/FedEx before it is
  //    delivered; "no tracking scraped on this pass" is NOT a terminal state.
  if (isDelivered !== true) {
    return { trackingNumbers: null, fabricated: false, reason: 'store-delivery-pending' };
  }

  // 6. Only here -- a DELIVERED store delivery will never get a carrier number
  //    -- do we emit the digits-only order-number placeholder, flagged as such.
  return { trackingNumbers: [digitsOnly(orderNumber)], fabricated: true, reason: 'store-delivery-final' };
}

module.exports = { resolveWalmartTracking, isFabricatedOrderNumberTracking, WALMART_INTERNAL_TRACKING_RE };
'''

p.write_text(NEW)
print("refimpl applied")
