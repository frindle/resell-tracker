# Extension deprecation — parity audit

Goal: make the headless `sidecar` container the only Amazon/Walmart sync
mechanism, and retire the browser extension.

Both feed the **same** `ExtensionCommand` queue and the **same**
`POST /api/import` endpoint, so this audit is a field-by-field comparison of
what each producer puts in an `ImportRow`, not a comparison of two systems.

Sources compared:

- `app/api/import/route.ts` — the `ImportRow` type (the contract).
- `sidecar/src/{amazon,walmart,poll,lib,login,loginFlow,loginQueue}.js`.
- The extension itself, at the sibling checkout
  `../resell-tracker-extension` (`src/content/amazon.ts`,
  `src/content/walmart.ts`, `src/background/index.ts`). This is a real
  source diff, not an inference from the sidecar's own porting comments.

---

## 1. Parity table — `ImportRow` fields

### Amazon

| field | extension | sidecar | gap? |
| --- | --- | --- | --- |
| `platform` | yes | yes | no |
| `orderNumber` | yes | yes | no |
| `orderDate` | yes (list + detail JSON/attr/text) | yes (same ported extractor) | no |
| `itemDescription` | yes | yes | no |
| `cost` | yes | yes | no |
| `shippingCost` | always `0` | always `0` | no (neither scrapes it) |
| `salePrice` | never sent | never sent | no — server-side field |
| `buyerId` | never sent | never sent | no — server resolves via `ShippingRule` |
| `cardId` | never sent | never sent | no — server resolves via `paymentLast4` |
| `cashbackAmount` | never sent | never sent | no — server computes (`computeCashback`) |
| `sourceUrl` | yes | yes | no |
| `shippingAddress` | yes (`Ship to` block) | yes (same ported extractor) | no |
| `trackingNumbers` | yes (detail + up to N tracking pages) | yes (`MAX_TRACKING_PAGES = 8`) | no |
| `paymentLast4` | yes (payment-box scoped) | yes (payment-box scoped) | no |
| `paymentRatePercent` | yes | yes | no |
| `noRushBonusPercent` | yes | yes | no |
| `deliveryPhotoUrl` | yes | yes | no |
| `deliveryPhotoBase64` | **not sent for Amazon** | not sent for Amazon | no — see §2 |
| `deliveryPhotoMime` | **not sent for Amazon** | not sent for Amazon | no — see §2 |

### Walmart

| field | extension | sidecar | gap? |
| --- | --- | --- | --- |
| `platform` | yes | yes | no |
| `orderNumber` | yes | yes | no |
| `orderDate` | yes | yes | no |
| `itemDescription` | yes | yes | no |
| `cost` | yes | yes | no |
| `shippingCost` | always `0` | always `0` | no |
| `salePrice` / `buyerId` / `cardId` / `cashbackAmount` | never sent | never sent | no — server-side |
| `sourceUrl` | yes | yes | no |
| `shippingAddress` | yes (`__NEXT_DATA__` + DOM fallback) | yes (same) | no |
| `trackingNumbers` | yes (regex over raw HTML) | yes (same) | no |
| `paymentLast4` | yes (JSON keys then text patterns) | yes (same) | no |
| `paymentRatePercent` | **not sent for Walmart** | not sent for Walmart | no — see §2 |
| `noRushBonusPercent` | **not sent for Walmart** | not sent for Walmart | no — Amazon-only concept |
| `deliveryPhotoUrl` | yes | yes | no |
| `deliveryPhotoBase64` | yes (in-page authed fetch) | **yes** (in-page authed fetch) | **no — already implemented** |
| `deliveryPhotoMime` | yes | **yes** | **no — already implemented** |

**Result: zero `ImportRow` field gaps for Amazon and Walmart.**

---

## 2. The specifically-flagged risky fields

### `deliveryPhotoBase64` / `deliveryPhotoMime` / `deliveryPhotoUrl` — NOT a gap

This was the headline risk and it turns out to be already closed.

- **Walmart** proof-of-delivery images sit behind a URL that needs the
  user's own session cookies. The extension solved this by fetching the
  bytes in-page and forwarding base64 (`FETCH_IMAGE_BYTES` via the
  background worker). The sidecar does the **same thing by the same
  mechanism** — `sidecar/src/walmart.js`, `extractDetailInBrowser()`, runs
  `fetch(photoSrc, { credentials: 'include' })` inside `page.evaluate()` on
  the authenticated Walmart page, base64-encodes the ArrayBuffer, and reads
  `content-type` for the mime. Because it's an in-page same-origin fetch on
  a logged-in context, the cookies apply without any extension privilege.
  `syncWalmart()` then copies `deliveryPhotoUrl`/`Base64`/`Mime` onto the
  order.
- **Amazon** photo URLs are self-contained signed S3 URLs, so *neither*
  producer sends bytes — both send the URL only and let
  `lib/deliveryPhoto.ts` path 1 fetch it server-side. That matches the
  comment on `ImportRow.deliveryPhotoUrl`.

So deprecating the extension does **not** lose delivery photos.

Naming note: `lib/deliveryPhoto.ts` and `app/api/import/route.ts` still
describe the inline-bytes path as "fetched by the extension" and log
`(extension didn't extract)`. That copy is now wrong — the sidecar is the
producer. Corrected as a safe-now change; the code path is untouched.

### `paymentLast4`, `paymentRatePercent`, `noRushBonusPercent` — NOT a gap

- `paymentLast4`: both producers, both platforms. The sidecar carries the
  Amazon fix where extraction is scoped to `[class*="paystationpaymentmethod"]`
  boxes first, so gift-card / promo-upsell "ending in ####" text earlier in
  the DOM can't win the first-match-wins search.
- `paymentRatePercent`: Amazon only, in **both** producers — same
  `(?:Earns|Get)\s+(\d+)%\s*back` match plus summing every `extra N%`. The
  extension's `walmart.ts` never had this field either (verified by grep),
  so Walmart's absence is parity, not regression. This is the field that
  disambiguates several saved cards sharing one last4 at different
  bonus-rate tiers.
- `noRushBonusPercent`: Amazon only, in both producers, identical regex.

### `trackingNumbers`, `shippingAddress`, `sourceUrl` — NOT a gap

All three are produced by both, from ported-verbatim extractors. Amazon
tracking in the sidecar walks the same detail page + up to 8 tracking
pages and applies the same dedupe/prefix-collapse/`slice(0,5)` cleanup.

---

## 3. The gap that *did* exist: `SYNC_AMAZON_ORDER` — now closed

The parity risk was not in `ImportRow` at all, it was in the **command
queue**.

`app/api/bfmr/sync-orders/route.ts` queues commands of type
`SYNC_AMAZON_ORDER` with payload `{orderNumbers:[...]}` — a targeted
re-scrape of specific Amazon orders BFMR knows about, which are routinely
older than the 60-day window the normal list walk covers. `/api/extension/commands`
accepts the type, and the extension handles it
(`background/index.ts` → `scrapeAmazonOrders()` in `content/amazon.ts`).

The sidecar's `poll.js` filtered pending commands with `SITES[c.type]`,
and `SITES` only had `SYNC_AMAZON` / `SYNC_WALMART`. So
`SYNC_AMAZON_ORDER` commands were **silently ignored forever** — they'd
sit `pending` with no error. Retiring the extension without fixing this
would have quietly broken BFMR-driven order backfill.

**Closed** in this change:

- `sidecar/src/amazon.js`: new `syncAmazonOrders(page, { orderNumbers })`,
  ported from the extension's `scrapeAmazonOrders()` — dedupes the
  requested ids, applies the same skip-locked filter via
  `/api/orders/locked-order-numbers`, fetches each detail page, skips
  `notFound`, and falls back to today's date when the page has no order
  date (same as the extension).
- `sidecar/src/poll.js`: `SYNC_AMAZON_ORDER` registered in `SITES` with
  `usesPayload: true` and `lastSyncKey: null`, plus a `parseCommandPayload`
  helper. The null watermark is deliberate — a targeted re-scrape says
  nothing about how far the list walk got, so advancing
  `amazon_sidecar_last_sync` from it would make the next full
  `SYNC_AMAZON` skip everything in between.

The sidecar's version is a strict **superset** of the extension's: the
extension's push for this command destructures only
`tracking/title/address/cost/orderDate/paymentLast4/paymentRatePercent`
and so silently drops `deliveryPhotoUrl` and `noRushBonusPercent` that its
own `fetchOrderDetails()` had already extracted. The sidecar forwards both.

---

## 4. Shared infrastructure — MUST NOT be removed

Verified by reading `sidecar/src/lib.js`:

| thing | used by sidecar? | verdict |
| --- | --- | --- |
| `X-Extension-User-Id` header | **yes** — `authHeaders()` sends it on every call | keep (rename at most) |
| `X-Extension-Secret` header | **yes** — `authHeaders()` sends it when the secret is set | keep (rename at most) |
| `EXTENSION_SHARED_SECRET` env | **yes** — read in `lib.js`; also `lib/autoSync.ts` and `proxy.ts` | keep |
| `lib/extensionAuth.ts` | **yes** — server side of the above, used by `/api/import` | keep |
| `X-Extension-Browser` header | **yes** — sidecar sends `'sidecar'` on GET poll and PATCH | keep |
| `/api/extension/commands` (+ `[id]`) | **yes** — the sidecar's entire trigger path | keep |
| `ExtensionCommand` Prisma model | **yes** — same queue | keep |
| `proxy.ts` `EXTENSION_ALLOWED` + CORS | **yes** — gates the routes the sidecar calls | keep |
| `EXTENSION_DATA_KEY` env | **not extension-related at all** | **keep — deleting it is destructive** |

`EXTENSION_DATA_KEY` deserves a specific warning: despite the name it has
nothing to do with the browser extension. It is the AES-256-GCM key for
`lib/secrets.ts`, which encrypts sensitive `Setting` values (CC/BG/BFMR
passwords, VNC password). Removing or rotating it makes every
`v1:`-prefixed setting undecryptable. It is misnamed, not deprecated.

Everything in this table is shared plumbing that the sidecar depends on.
A rename (`X-Extension-*` → `X-Sync-*`, `EXTENSION_SHARED_SECRET` →
`SYNC_SHARED_SECRET`) would be a coordinated change across `proxy.ts`,
`lib/extensionAuth.ts`, `lib/autoSync.ts`, `sidecar/src/lib.js`,
`docker-compose.yml`, and the user's `.env` — deferred, not done here.

---

## 5. Extension capabilities with NO sidecar equivalent

These are **out of scope** of "Amazon/Walmart sync" but they are the
reason the extension cannot be uninstalled outright. Each is a real
blocker for full retirement:

| capability | command / mechanism | sidecar equivalent |
| --- | --- | --- |
| Costco order sync | `SYNC_COSTCO` (`content/costco.ts`, `costco-interceptor.ts`) | **none** |
| ~~BigSky Buyers sync~~ | ~~`SYNC_BIGSKY`~~ | **already server-side — NOT an extension dependency** (see note) |
| CashbackMonitor rates | `SCRAPE_CBM` (`content/cashbackmonitor.ts`) | **being removed entirely (feature retired)** |

### BigSky — CONFIRMED already server-side (2026-08-24 re-trace)

The original audit listed BigSky as extension-blocked. Tracing the *current*
code end to end shows that is stale — BigSky needs no extension:

- `instrumentation.ts` → `startAutoSync()` (`lib/autoSync.ts`) runs on a
  timer. For every user with a `bigsky_cookie` setting it calls
  `loopbackPost('/api/bigsky/sync-orders', uid, { fetch: true })`.
- `app/api/bigsky/sync-orders/route.ts` with `fetch:true` reads the stored
  `bigsky_cookie` and calls `fetchScanItems()` / `fetchNotCheckedInTracking()`
  in `lib/bigsky.ts` — server-side HTTP scraping of `bigskybuyers.com`, no
  browser involved.
- Login is also server-side: `app/api/bigsky/auth/send-otp` +
  `verify-otp` drive better-auth's email-OTP flow from Node and store the
  session cookie. `lib/bigskyHealth.ts` monitors expiry.

The `SYNC_BIGSKY` button in Settings and its entry in the
`/api/extension/commands` `valid` list are a legacy manual trigger that only
the extension ever claimed — redundant with the server-side auto-sync above.
**BigSky can be dropped from the "still needs extension" list.**
| API Spy | `content/api-spy-{bridge,main}.ts` — passively observes the user's own browsing of BG/CC sites and POSTs to `/api/api-errors`, `/api/buyinggroup` | **none, and arguably not portable** — it depends on the human actually using those sites in their browser |
| Live sync banner in tracker UI | `content/tracker-status.ts`, mounts at `data-rt-sync-target` on `/orders` | **none** — sidecar runs headless, status only via the command table |

The Settings page still queues `SYNC_COSTCO` / `SYNC_BIGSKY` /
`SCRAPE_CBM`, and `/api/extension/commands` still accepts them. Those
buttons only work with the extension installed.

---

## 6. Files that would need to change for a full retirement

Already changed here (safe now):

- `sidecar/src/amazon.js`, `sidecar/src/poll.js` — close the
  `SYNC_AMAZON_ORDER` gap.
- `README.md` — sidecar is the primary/recommended Amazon+Walmart path;
  extension marked deprecated for those two.
- `app/settings/page.tsx`, `app/orders/page.tsx` — copy says "sync
  worker" rather than asserting the browser extension is what picks the
  command up; Amazon/Walmart marked as sidecar-served.
- `lib/deliveryPhoto.ts`, `app/api/import/route.ts` — comment/log copy
  corrected (the inline-bytes producer is the sidecar now).

Blocked on §5, NOT changed:

- Removing the `SYNC_COSTCO` / `SYNC_BIGSKY` / `SCRAPE_CBM` buttons or
  their entry in the `valid` list in `app/api/extension/commands/route.ts`.
- Removing the `data-rt-sync-target` mount point on `/orders`.
- Removing `targetBrowser` from `ExtensionCommand` (only meaningful with
  two real browser extensions in play).

Must not be removed at all: everything in §4.

Not in this repo: the extension source lives in the separate repo
`frindle/resell-tracker-extension`. **Flagged, not touched.**

---

## 7. Verdict

**Can the extension be retired today? For Amazon and Walmart order
syncing — yes. As a whole — no.**

- Amazon + Walmart `ImportRow` parity is complete, including the
  delivery-photo path that was the main suspected loss. With
  `SYNC_AMAZON_ORDER` now implemented, the sidecar handles every command
  type that touches Amazon or Walmart.
- The extension remains **required** for Costco, the API Spy, and the live
  sync banner. BigSky is already fully server-side (§5 note) and
  CashbackMonitor is being removed as a feature, so neither blocks
  retirement any longer.

Recommended posture: stop using the extension for Amazon/Walmart, keep it
installed for the remaining §5 capabilities (Costco, API Spy, sync banner),
and port Costco to the sidecar as the next unit of work.

### Update log (2026-08-24)

- **A.** BigSky confirmed server-side; dropped from the blocker list.
- **B.** CashbackMonitor (CBM) + `PortalRate` removed entirely — model,
  `/api/portal-rates/*` routes, both deals-page rate UIs, the
  `ignored_portals` / hide-cashback settings, and the `SCRAPE_CBM` command.
- **C.** Costco order sync ported into the sidecar (`sidecar/src/costco.js`).
- **D.** Costco in-warehouse gift-card orders imported via `tenderArray`.
