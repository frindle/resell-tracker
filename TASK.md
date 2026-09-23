# TASK: rt-walmart-store-tracking-gate

## Confirmed defect (observed, not suspected)

Commit 82b8fc1 deleted the `isStoreDelivery` gate in sidecar/src/walmart.js. The
fallback `'else order.trackingNumbers = [order.orderNumber.replace(/[^0-9]/g, "")]'`
now fires unconditionally whenever no carrier tracking was scraped -- including on
orders that have not shipped yet and will later ship UPS or FedEx. That fabricated
value is TERMINAL downstream: app/api/bfmr/push-tracking/route.ts selects every order
with non-null trackingNumbers and submits it to BFMR, and submitTracking() skips BFMR
rows that already have a tracking number set, so a real carrier number can never
replace it on BFMR's side afterwards. Verified by reading the post-82b8fc1 walmart.js
branch (no gate remains) and the push-tracking/submitTracking selection logic above.

## Entry point

sidecar/src/walmartTracking.js:1 (NEW file -- this dispatch creates it; nothing else is wired to it yet)

## Required change

In sidecar/src/walmartTracking.js (NEW file, dependency-free CommonJS -- it must require() nothing, exactly like sidecar/src/syncWindow.js, so lib/*.test.ts can default-import it under node --experimental-strip-types --test): the single decision for what a Walmart order's trackingNumbers become after a detail-page scrape, so a fabricated order-number placeholder can never be confused with, or block, a later real carrier tracking number. The decision must refuse to fabricate anything for an order that could still ship by carrier.

Export exactly: `module.exports = { resolveWalmartTracking, isFabricatedOrderNumberTracking, WALMART_INTERNAL_TRACKING_RE };`

- `WALMART_INTERNAL_TRACKING_RE` = `/^555\d{15,}$/` -- Walmart-internal reference ids that are never real carrier tracking.
- `isFabricatedOrderNumberTracking(value, orderNumber)` -> boolean. True when both are non-empty and value's digits-only form equals orderNumber's digits-only form. Mirrors app/api/import/route.ts's isOrderNumberTracking so downstream and scraper agree on what a placeholder looks like.
- `resolveWalmartTracking({ orderNumber, scrapedTracking, isStoreDelivery, isDelivered })` -> `{ trackingNumbers, fabricated, reason }`. `scrapedTracking` is an array of raw strings from the detail page (may be empty/undefined). `trackingNumbers` is a string[] or null. `fabricated` is a boolean. `reason` is one of `'carrier'`, `'not-store-delivery'`, `'store-delivery-pending'`, `'store-delivery-final'`, `'no-order-number'`.

Decision order, top to bottom:
1. Filter scrapedTracking: drop any falsy/blank value, any value that isFabricatedOrderNumberTracking against orderNumber, and any value matching WALMART_INTERNAL_TRACKING_RE.
2. If anything survives -> `{ trackingNumbers: survivors, fabricated: false, reason: 'carrier' }`. Real carrier tracking ALWAYS wins and is never suppressed by any other flag.
3. Else if orderNumber is missing/blank -> `{ trackingNumbers: null, fabricated: false, reason: 'no-order-number' }`.
4. Else if isStoreDelivery is not true -> `{ trackingNumbers: null, fabricated: false, reason: 'not-store-delivery' }`. This is the restored gate: an order that is not a store delivery may still ship by carrier, so never invent tracking for it.
5. Else if isDelivered is not true -> `{ trackingNumbers: null, fabricated: false, reason: 'store-delivery-pending' }`. A store delivery can still be re-routed to UPS/FedEx before it is delivered, so 'no tracking scraped on this pass' is NOT a terminal state.
6. Else -> `{ trackingNumbers: [orderNumber digits only], fabricated: true, reason: 'store-delivery-final' }`. Only a DELIVERED store delivery gets the order-number placeholder.

Hard properties (each costs real money when wrong):
- A not-yet-shipped, non-store order with zero scraped tracking returns null, NOT a fabricated value (the exact regression).
- A store-delivery order that is not yet delivered returns null, NOT a fabricated value.
- Real carrier tracking wins over every flag combination: even with isStoreDelivery true and isDelivered true, a surviving 1Z/TBA/9xx value is returned with fabricated false.
- A scraped value equal to the order number (with or without dashes) is filtered out and must never be returned as 'carrier'.
- A 555-prefixed Walmart-internal value is filtered out and, on its own, leaves the order with null rather than a fake carrier number.
- fabricated is true on exactly one path (store-delivery-final) and false on every other.
- Pure: no clock read, no network, no DB, no require().

Behaviour that must NOT change:
- The placeholder's VALUE format stays digits-only order number -- app/api/import/route.ts's isValidTracking and the BFMR submit path already encode that convention; a new format would be pushed verbatim to BFMR. The fix is WHEN it is produced, plus the explicit fabricated flag.
- Real carrier tracking numbers are returned exactly as scraped (survivors of the filter), never rewritten or reordered.

## Must contain

- `resolveWalmartTracking`
- `isFabricatedOrderNumberTracking`
- `WALMART_INTERNAL_TRACKING_RE`
- `/^555\d{15,}$/`
- `'carrier'`
- `'not-store-delivery'`
- `'store-delivery-pending'`
- `'store-delivery-final'`
- `'no-order-number'`

## Scope

Only edit `sidecar/src/walmartTracking.js`; do not edit `verify.sh`, `verify.test.ts` or `TASK.md`.
verify.test.ts is the test fixture -- changing it invalidates the check.

## Keep every changed line exercised (relevance)

After the job runs, a mutation check flips/deletes each line you changed and
asks the verify to catch it. A changed line whose every mutant survives --
because no test asserts it -- FAILS the gate even when the fix is correct, and
the review never runs. So do NOT emit an isolated, untested line:
- Fold an unavoidable constant onto a line the test already exercises. Put a
  `timeout=` / a `daemon=True` flag / a small tuning number on the SAME line as
  a header dict, URL, or argument the fixture checks -- never on its own line.
- Prefer falling through to an implicit `return None` over a standalone
  `return None` in an `except:` the tests do not assert.
- If a line genuinely cannot be asserted and cannot be folded, it usually
  should not be a separate line at all -- restructure so it isn't.
This is not about adding bogus assertions for constants; it is about not
leaving a lone line that carries no tested behaviour.

## Loop instruction

Run `bash verify.sh` after every edit and keep editing until it prints
`VERIFY_OK`.
