# TASK: rt-walmart-delivered-signal-wiring-v2

## Confirmed defect (observed, not suspected)

CONFIRMED on resell-tracker main at 03009d6 (read directly, 2026-09-23):

- `sidecar/src/walmart.js:442-444` still fabricates tracking UNCONDITIONALLY:
  `if (filteredTracking.length) order.trackingNumbers = filteredTracking;`
  `else order.trackingNumbers = [order.orderNumber.replace(/[^0-9]/g, '')];`
  Every order with no scraped carrier number -- including one that has simply
  not shipped yet and will later ship UPS/FedEx -- gets the digits-only order
  number written as its tracking number. That value is terminal downstream
  (push-tracking submits it to BFMR; submitTracking() skips rows that already
  have a number), so a real carrier number can never replace it.
- `extractDetailInBrowser` (walmart.js:200-359) derives `isStoreDelivery`
  (line 251, `/Delivery\s+from\s+store/i`) and returns it on the detail object
  (line 357) -- but the call site NEVER reads it. No `isDelivered` signal
  exists anywhere in the file (grep: zero hits for `Delivered`).
- `sidecar/src/walmartTracking.js` (landed in 03009d6) already exports
  `resolveWalmartTracking({ orderNumber, scrapedTracking, isStoreDelivery, isDelivered })`
  returning `{ trackingNumbers: string[] | null, fabricated: boolean, reason }`.
  It is DEAD CODE: nothing imports it (grep: no `require('./walmartTracking` on main).

## Entry point

- NEW file `sidecar/src/walmartDetailSignals.js` (currently a stub) -- the
  fulfillment-signal module.
- `sidecar/src/walmart.js:251` (add `isDelivered` beside `isStoreDelivery`),
  `sidecar/src/walmart.js:357` (return it), `sidecar/src/walmart.js:442-444`
  (the ONE call site to rewire).

## Required change

### Part 1 -- `sidecar/src/walmartDetailSignals.js` (NEW, dependency-free CommonJS)

Exactly like `sidecar/src/syncWindow.js` and `sidecar/src/walmartTracking.js`:
`'use strict'`, `require()` NOTHING, `module.exports = {...}` at the bottom, so
the repo's `node --experimental-strip-types --test` can import it without
pulling in playwright. Replace the stub's `export {};` entirely -- the file
must be CommonJS, not ESM.

Contract:
- Export exactly: `module.exports = { detectWalmartFulfillment, STORE_DELIVERY_RE, DELIVERED_RE }`.
- `function detectWalmartFulfillment(html, orderNumber)` ->
  `{ isStoreDelivery: boolean, isDelivered: boolean }`. Pure: a string (plus an
  optional order number) in, two booleans out. No DOM, no require(), no clock,
  no network. `null` / `undefined` / `''` html yields
  `{ isStoreDelivery: false, isDelivered: false }` and must not throw.
- `STORE_DELIVERY_RE` detects a local-store-driver delivery. It must keep
  matching EXACTLY what walmart.js:251 matches today -- `/Delivery\s+from\s+store/i`
  -- (a pure lift, no behaviour change) AND ALSO match the caption-id form
  Walmart emits, `id="caption-<orderNumber>-Delivery_from_store"` (underscores,
  not spaces).
- `DELIVERED_RE` detects the terminal delivered state: the standalone word
  `Delivered` on a word boundary, plus the caption-id form
  `id="caption-<orderNumber>-Delivered"`.
- When `orderNumber` is given, the caption-id forms are scoped to THAT order:
  `caption-9999999999-Delivered` must NOT set isDelivered for order `5034976218`.
- Both flags independent: both markers -> both true; neither -> both false.
- Case-insensitive; tolerant of collapsed/expanded whitespace between words.

Hard properties the adversarial cases pin (a naive `/deliver/i` build fails them):
- `Delivery from store` alone -> isStoreDelivery true, isDelivered FALSE (the
  premature-fallback case: the order can still be re-routed to UPS/FedEx).
- Substring trap: the word `Delivery` must NEVER satisfy `DELIVERED_RE`. html
  with only `Delivery from store` or only `Estimated delivery` has isDelivered false.
- Negated text does not read as delivered: `Not delivered`, `Not yet delivered`,
  `Delivery date` all leave isDelivered false.
- `Delivered Sep 21, 2026` sets isDelivered true.

### Part 2 -- wire `sidecar/src/walmart.js` (structural pin; it cannot be unit-driven, it requires playwright)

1. Import the decision module at the top beside the other requires
   (walmart.js:30-31): `const { resolveWalmartTracking } = require('./walmartTracking');`
2. `extractDetailInBrowser` runs INSIDE `page.evaluate` (browser context) --
   it cannot `require()` anything, so `detectWalmartFulfillment` cannot be
   called there. Derive `isDelivered` inline right after the existing
   `isStoreDelivery` line, mirroring `DELIVERED_RE`'s pattern, e.g.
   `const isDelivered = /\bDelivered\b|caption-\d+-Delivered/i.test(html);`
   Do NOT change the existing `isStoreDelivery` line (251) -- its behaviour is
   pinned unchanged. The fixture extracts this `isDelivered` regex from the
   source text and drives it against the substring-trap cases, so the pattern
   must reject `Delivery from store` / `Estimated delivery` and accept
   `Delivered Sep 21, 2026` / `caption-5034976218-Delivered`.
3. The returned detail object (walmart.js:357) must carry `isDelivered`
   alongside `isStoreDelivery`:
   `address, tracking: [...numbers], isStoreDelivery, isDelivered, orderDate, cost, itemDescription,`
4. Replace the two fallback lines at walmart.js:443-444 with the decision call,
   keeping `trackingNumbers` an ARRAY (the rest of the codebase expects one):
   ```
   order.trackingNumbers = resolveWalmartTracking({
     orderNumber: order.orderNumber,
     scrapedTracking: filteredTracking,
     isStoreDelivery: detail.isStoreDelivery,
     isDelivered: detail.isDelivered,
   }).trackingNumbers ?? [];
   ```
   `resolveWalmartTracking` returns `{ trackingNumbers: string[] | null, ... }`
   -- you MUST unwrap `.trackingNumbers` and map `null` to `[]`.
5. The literal text `else order.trackingNumbers = [order.orderNumber.replace(`
   must be GONE from walmart.js.

Behaviour that must NOT change:
- `STORE_DELIVERY_RE` keeps matching exactly `/Delivery\s+from\s+store/i`
  (pure lift), and walmart.js:251 is untouched.
- Orders with a real scraped carrier tracking number still get it
  (resolveWalmartTracking returns `{ trackingNumbers: survivors }` for those).
- A non-store order with no tracking number yet gets NO placeholder -- an
  EMPTY array, not the order number. That is the whole point of the gate.
- Nothing else in walmart.js changes (no other call sites, no other returns).

## Must contain

- `module.exports = { detectWalmartFulfillment, STORE_DELIVERY_RE, DELIVERED_RE }`
- `function detectWalmartFulfillment`
- in sidecar/src/walmart.js: `require('./walmartTracking')`
- in sidecar/src/walmart.js: `resolveWalmartTracking({`
- in sidecar/src/walmart.js: `isDelivered: detail.isDelivered`
- in sidecar/src/walmart.js: `.trackingNumbers ?? []`

(The gate holds the reference impl against this list. If the verify goes green
while one of these is absent from the changed files, the verify does not
enforce the spec -- that is a benign verify, caught mechanically.)

## Scope

Only edit `sidecar/src/walmartDetailSignals.js`, `sidecar/src/walmart.js`; do not edit `verify.sh`, `verify.test.ts` or `TASK.md`.
verify.test.ts is the test fixture -- changing it invalidates the check.
Do NOT edit `sidecar/src/walmartTracking.js` -- it is already correct on main; call it.

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
