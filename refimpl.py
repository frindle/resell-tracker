#!/usr/bin/env python3
r"""Reference impl for: rt-walmart-delivered-signal-wiring-v2

The gate applies this, runs the verify, and reverts it. It proves two things at
once: the task is SATISFIABLE as specified, and the verify actually ENFORCES
the spec (a refimpl that goes green while a "Must contain" literal is absent
means the verify is benign).

Writes/edits two files (walmartTracking.js already exists on main @ 03009d6):
  - sidecar/src/walmartDetailSignals.js   (NEW -- the fulfillment-signal module)
  - sidecar/src/walmart.js                (EDIT -- import resolveWalmartTracking;
                                           extractDetailInBrowser gains isDelivered;
                                           the tracking fallback is routed through
                                           resolveWalmartTracking(...).trackingNumbers ?? [])

All embedded target source uses RAW strings so `\s`, `\b` etc. stay literal.
"""
import pathlib
import sys

wt = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")

# --- sidecar/src/walmartDetailSignals.js (NEW file, dependency-free CJS) ----
SIGNALS = r'''// Walmart order-detail fulfillment signals.
//
// Dependency-free CommonJS on purpose -- exactly like syncWindow.js and
// walmartTracking.js -- so a *.test.ts can import it under
// `node --experimental-strip-types --test` without pulling in playwright
// (which sidecar/src/walmart.js requires).
//
// Two independent booleans, both derived from the raw detail-page HTML:
//   isStoreDelivery  -- fulfilled by a local store's driver, not a carrier.
//                       Lifted verbatim from walmart.js's extractDetailInBrowser
//                       (/Delivery\s+from\s+store/i), plus the caption-id form
//                       Walmart emits (id="caption-<orderNumber>-Delivery_from_store").
//   isDelivered      -- the terminal state: the order actually arrived.
//                       The standalone word "Delivered" on a word boundary, or
//                       id="caption-<orderNumber>-Delivered". NOTE: "Delivery"
//                       must NEVER satisfy this -- a store delivery that has not
//                       arrived yet can still be re-routed to UPS/FedEx.
//
// walmart.js's extractDetailInBrowser runs inside page.evaluate and cannot
// require() this module, so it mirrors DELIVERED_RE inline; the fixture drives
// both copies against the same trap cases.

'use strict';

const STORE_DELIVERY_RE = /Delivery\s+from\s+store|caption-\d+-Delivery_from_store/i;
// Standalone "Delivered": not negated ("Not delivered" / "Not yet delivered")
// and not the tail of a caption id (that form is matched -- and order-scoped --
// by the second alternative, so "-Delivered" must not leak through the first).
const DELIVERED_RE = /(?<!\bnot\s+(?:yet\s+)?)(?<!-)\bDelivered\b|caption-\d+-Delivered/i;

/**
 * @param {string|null|undefined} html the detail page's raw HTML (outerHTML)
 * @param {string} [orderNumber] order number, scoping the caption-id forms
 * @returns {{ isStoreDelivery: boolean, isDelivered: boolean }}
 */
function detectWalmartFulfillment(html, orderNumber) {
  const text = typeof html === 'string' ? html : '';
  let storeRe = STORE_DELIVERY_RE;
  let deliveredRe = DELIVERED_RE;
  if (orderNumber != null && String(orderNumber).length > 0) {
    // Order-number-scoped: the caption-id form is pinned to THIS order's id,
    // so a caption for another order cannot fire this order's flags.
    const n = String(orderNumber).replace(/[^0-9A-Za-z_-]/g, '');
    storeRe = new RegExp('Delivery\\s+from\\s+store|caption-' + n + '-Delivery_from_store', 'i');
    deliveredRe = new RegExp('(?<!\\bnot\\s+(?:yet\\s+)?)(?<!-)\\bDelivered\\b|caption-' + n + '-Delivered', 'i');
  }
  return {
    isStoreDelivery: storeRe.test(text),
    isDelivered: deliveredRe.test(text),
  };
}

module.exports = { detectWalmartFulfillment, STORE_DELIVERY_RE, DELIVERED_RE };
'''

# --- sidecar/src/walmart.js edits -------------------------------------------
WM_OLD_IMPORTS = r"""const { SessionExpiredError, fetchLockedOrderNumbers } = require('./lib');
const syncWindow = require('./syncWindow.js');"""
WM_NEW_IMPORTS = r"""const { SessionExpiredError, fetchLockedOrderNumbers } = require('./lib');
const syncWindow = require('./syncWindow.js');
const { resolveWalmartTracking } = require('./walmartTracking');"""

# extractDetailInBrowser runs inside page.evaluate (browser context), so it
# cannot require() the signals module -- mirror DELIVERED_RE inline. The
# isStoreDelivery line itself is left untouched (pure lift, no behaviour change).
WM_OLD_DETECT = r"""  const isStoreDelivery = /Delivery\s+from\s+store/i.test(html);
"""
WM_NEW_DETECT = r"""  const isStoreDelivery = /Delivery\s+from\s+store/i.test(html);
  // Terminal state. Mirrors DELIVERED_RE in sidecar/src/walmartDetailSignals.js
  // (page.evaluate cannot require() it). "Delivered" on a word boundary or the
  // caption-id form; the word "Delivery" alone must never read as delivered --
  // an undelivered store delivery can still be re-routed to UPS/FedEx.
  const isDelivered = /(?<!\bnot\s+(?:yet\s+)?)(?<!-)\bDelivered\b|caption-\d+-Delivered/i.test(html);
"""

WM_OLD_RETURN = r"""    address, tracking: [...numbers], isStoreDelivery, orderDate, cost, itemDescription,"""
WM_NEW_RETURN = r"""    address, tracking: [...numbers], isStoreDelivery, isDelivered, orderDate, cost, itemDescription,"""

WM_OLD_FALLBACK = r"""    const filteredTracking = detail.tracking.filter(t => t !== order.orderNumber);
    if (filteredTracking.length) order.trackingNumbers = filteredTracking;
    else order.trackingNumbers = [order.orderNumber.replace(/[^0-9]/g, '')];"""
WM_NEW_FALLBACK = r"""    const filteredTracking = detail.tracking.filter(t => t !== order.orderNumber);
    // Real carrier tracking wins; otherwise ONLY a DELIVERED store delivery gets
    // the order-number placeholder (see walmartTracking.js). null -> [] keeps
    // trackingNumbers an array, as the rest of the pipeline expects.
    order.trackingNumbers = resolveWalmartTracking({
      orderNumber: order.orderNumber,
      scrapedTracking: filteredTracking,
      isStoreDelivery: detail.isStoreDelivery,
      isDelivered: detail.isDelivered,
    }).trackingNumbers ?? [];"""


def main():
    src_dir = wt / 'sidecar' / 'src'
    src_dir.mkdir(parents=True, exist_ok=True)

    (src_dir / 'walmartDetailSignals.js').write_text(SIGNALS)
    print('refimpl wrote sidecar/src/walmartDetailSignals.js')

    wm = src_dir / 'walmart.js'
    t = wm.read_text()
    for old, new in [
        (WM_OLD_IMPORTS, WM_NEW_IMPORTS),
        (WM_OLD_DETECT, WM_NEW_DETECT),
        (WM_OLD_RETURN, WM_NEW_RETURN),
        (WM_OLD_FALLBACK, WM_NEW_FALLBACK),
    ]:
        if new in t and old not in t:
            continue  # already applied -- idempotent re-run
        assert old in t, 'walmart.js anchor not found:\n' + old[:120]
        t = t.replace(old, new, 1)
    wm.write_text(t)
    print('refimpl wired sidecar/src/walmart.js')


if __name__ == '__main__':
    main()
