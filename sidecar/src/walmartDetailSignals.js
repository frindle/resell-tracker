'use strict';

// Fulfillment-signal detection for Walmart order detail pages, split out of
// extractDetailInBrowser so it can be unit-driven without playwright. Pure:
// a string (plus an optional order number) in, two booleans out. No DOM, no
// require(), no clock, no network -- the repo's `node --experimental-strip-types
// --test` imports this directly.
//
// The two signals are independent and feed resolveWalmartTracking:
//   - isStoreDelivery: Walmart fulfilled via a local store driver (no carrier).
//     STORE_DELIVERY_RE is a pure lift of walmart.js's `/Delivery\s+from\s+store/i`
//     plus the caption-id form Walmart emits (`caption-<orderNumber>-Delivery_from_store`).
//   - isDelivered: the terminal delivered state. DELIVERED_RE matches the
//     standalone word `Delivered` (never the substring in `Delivery`) with two
//     traps dodged via lookbehind: a preceding `not` / `not yet` (negation) and
//     a preceding `-` (the caption tail, which only the order-scoped caption
//     alternative may match).

const STORE_DELIVERY_RE = /Delivery\s+from\s+store|caption-\d+-Delivery_from_store/i;
const DELIVERED_RE = /(?<!\bnot\s+(?:yet\s+)?)(?<!-)\bDelivered\b|caption-\d+-Delivered/i;

// Escape a literal string for safe embedding in a RegExp source. The order
// number is matched LITERALLY: '503497621.' must not wildcard onto
// caption-5034976218-...
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Detect Walmart fulfillment signals in a detail page's HTML.
 *
 * @param {string|null|undefined} html raw detail-page HTML; non-strings are ignored (never coerced)
 * @param {string|number|null|undefined} [orderNumber] when given, the caption-id forms are scoped to THIS order number (matched literally); when undefined/null/'' the caption forms of any order count
 * @returns {{ isStoreDelivery: boolean, isDelivered: boolean }}
 */
function detectWalmartFulfillment(html, orderNumber) {
  if (typeof html !== 'string' || html === '') return { isStoreDelivery: false, isDelivered: false };

  const scoped = orderNumber != null && String(orderNumber) !== '';
  // Caption-id number slot: the literal (escaped) order number when scoped,
  // otherwise any digits. `caption-x-Delivered` is not a caption id and never matches.
  const capId = scoped ? escapeRegExp(String(orderNumber)) : '\\d+';

  return {
    isStoreDelivery: new RegExp(`Delivery\\s+from\\s+store|caption-${capId}-Delivery_from_store`, 'i').test(html),
    isDelivered: new RegExp(`(?<!\\bnot\\s+(?:yet\\s+)?)(?<!-)\\bDelivered\\b|caption-${capId}-Delivered`, 'i').test(html),
  };
}

module.exports = { detectWalmartFulfillment, STORE_DELIVERY_RE, DELIVERED_RE };
