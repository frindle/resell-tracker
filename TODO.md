# Resell Tracker — TODO

Last updated: 2026-07-01

## Active — session 2026-07-01

### Amazon rescrape — skip locked orders
Once `order.locked=true`, don't re-check that order on subsequent Amazon rescrapes. Otherwise every future sync grows more expensive.

### Order detail — don't redirect on Save; add "Save and Lock" button
Currently Save kicks user back to /orders. Should stay on the detail page. Also add a "Save and Lock" button next to Save that saves + sets `locked=true` in one action.

### Order detail — package value input page-jump + pre-fill
Two fixes in one:
- Input is `<input type="number">` which triggers scroll-into-view on keystroke → page jumps. Fix with `onWheel={e=>e.currentTarget.blur()}` and/or switching to `type="text" inputMode="decimal"`.
- Pre-fill from `linkedCommitment.value` when the field is blank. Don't overwrite user-typed values.

### Search — add card last-4 to main /orders search
The main search box should also match `giftCard.code` last-4 digits. So typing "1234" surfaces orders with a card ending in 1234.

### Rename "touched" → "verified" in sync-summary
Sync summary currently says "N orders touched: N re-checked with no field changes." User confirmed: keep "verified" only. Drop the "touched" wording.

### Header consolidation
- Drop Import from top nav (rarely used).
- Move Address Rules under Settings.
- Merge Sync + Errors into one tab — name: user has no preference, use "Activity."

### Firefox — gift card code input still overwrites on first digit
Prior audit (#30) fixed most text inputs. User reports the gift card code entry box (on the order detail / card entry flow) still exhibits the pattern: type one digit → clears previous → have to click out+back in. Scope this fix narrowly to that component.

### Manual order timestamp bug (America/Los_Angeles)
User creates a manual Costco in-store order at 10:30 AM Pacific; order timestamp saves as 3:33 AM. Browser TZ is `America/Los_Angeles`. Not a straight timezone offset — 10:30 AM PDT ≠ 3:33 AM in any common conversion. Suspect: form defaults `orderedAt` to `new Date()` on mount but doesn't refresh on submit; or uses a date-picker that renders in UTC but submits in local. Repro path: open manual-order form, wait, save. Compare stored `orderedAt` vs actual submit time.

### CardCenter — partial-paid false positive (P1056-20260709)
Real example: `Expected $80.00 / Paid $40.00, due 2026-07-09`. User confirms detection is wrong — no $40 was posted 9 days early. Trace `sync-payments` — likely reading a pending payment as posted, or a payment reference for one card being mis-summed into another.

### Delivery deadline field
New `Order.deliveryDeadline: DateTime?`. Surface: **badge on the order card** when the deadline is within N days (default 3). Editable on the order detail page.

### BG — truncated payment number reconciliation
Example: order `200014866331820` (15 digits) — BG processed as `20001486633182` (14 digits, dropped trailing "0"). Fix in `sync-payments`/`applyPayment`: match candidates by full number **and** last-digit-dropped variants when the exact match fails. Log every fuzzy hit as `[bg/payment-reconcile] fuzzy match: {full} ↔ {portal}`. Also check source parser to see if we're truncating anywhere on our side.

### BG — truncated payment source-side investigation
Sub-task: grep our BG scrape/parse code for any regex that could drop a trailing digit (`.{14}`, `\d{14}`, integer parse that overflows JS safe range at 16 digits — order number fits, so unlikely). If our side is clean, the truncation is BG's portal — the reconciler above is the whole fix.

### Auto-link-by-tracking policy — HOLD
User is deciding between (a) off, (b) link but never touch salePrice, (c) link but only touch salePrice when unlocked. Not implementing until answer received.

### BFMR reservation linker salePrice discrepancies — HOLD
Need one concrete example order ID + expected vs actual salePrice to trace.

---


## In-flight (uncommitted, mid-implementation)

### CardCenter: transition `ccGiftCardId` → `ccListingId` for payment matching
**Status:** Schema migration + sync-payments rewrite already on disk uncommitted (`git status` shows `M prisma/schema.prisma`, `M app/api/cardcenter/sync-payments/route.ts`, `?? prisma/migrations/20260623140837_add_giftcard_listing_id/`). **The user clarified:** CC's payment is tied to the *listing* ID (e.g. `9045043`), not the gift-card ID (`8232432`). A card can have multiple listings over time (re-listings, each with its own payment). We need to store *both*: `ccGiftCardId` for card identity, `ccListingId` for the specific sale event. Matching preference: ccListingId → ccGiftCardId → code-suffix → merchant+value.

**Need to do before shipping:**
- Wire `ccListingId` writes into `app/api/cardcenter/submit/route.ts` so newly-submitted cards persist both IDs (currently `submit/route.ts` only stores `ccGiftCardId`; need to fetch the listing.id from the submission detail response).
- Verify the matching cascade in the new sync-payments code I left mid-write — there's a `byCard` lookup that may double-count when a card has both old `ccGiftCardId` and new `ccListingId` set.
- Decide whether to backfill `ccListingId` from existing matched cards on the first post-deploy `sync-payments` run.

**Deploy verification commands:**
```
cd /mnt/user/appdata/reselling && ./update.sh
docker logs --tail 500 reselling-app-1 2>&1 | grep '\[cc/sync-payments\]' | tail -60
```

---

## Active

### CardCenter — multiple reservations per order: state gets stuck after first card submitted
When a CC order has multiple reservations (e.g. 4× Bath & Body Works $50), submitting the first card causes the other reservations to be ignored / hidden on subsequent submissions. Need to investigate how submit/route.ts handles the reservation list and ensure the remaining open reservations stay reachable per card.

**Blocker — need from user:** Confirm whether this happens only when the cards are *different brands* on the same order, or also when they're the same brand (the BBW × 4 case). Walk me through the steps that reproduce it once.

### CardCenter — ParsedCards rejects code/PIN even when manual entry on CC site works
Sample failure from the spy: `"Valid Southwest Airlines code and PIN not found"` returned for a card the user entered manually on cardcenter.cc successfully. Our submit must be sending the code or PIN in the wrong shape for some brands.

**Need from user:** When this happens next, copy from the dev-mode API Spy (a) the exact `reqBody` we're sending to `/Api/Reservations/{id}/ParsedCards`, and (b) the request shape you used when manual entry worked on cardcenter.cc (open Network tab, look for the same endpoint). The brand likely needs a different separator or omits the PIN.

### CardCenter — order total `salePrice` and payment due date not updating from per-card values
User reports per-card sale prices show correctly on the order detail page, but the order's *total* `salePrice` and `paymentDueAt` are not updating.

**Likely cause:** the order update path only fires inside `submit/route.ts` (which the user wouldn't be calling for cards uploaded directly to CC). `sync-payments` populates `bgPaidAmount` per order but not `salePrice`. Need to make `sync-payments` also sum per-card `ccPurchasePrice` into `order.salePrice` (when not locked) and project earliest `paymentDueDate` into `paymentDueAt`.

### CardCenter — partial-payment "Overdue since 2026-07-09" badge on order with payment due 2 weeks out
Reported example:
```
CardCenter payment — Partial
Expected: $80.00
Paid:     $40.00
Reference: P1056-20260709
Overdue since: 2026-07-09
```
The order shouldn't be "overdue" since the due date hasn't passed. `lib/bgSync.ts` and/or `PaymentInfo` is confusing `overdueAt` (which we use as a "due date" picker) with "this is past due NOW." Two-part fix: split the field semantics, or stop showing the "Overdue since" badge when `overdueAt > now`.

### CardCenter — detect changed payment amounts across syncs
If a `payment.amount` changes between consecutive `sync-payments` runs for the same payment ID, identify which listing changed and update only that card's `ccPurchasePrice` (don't blindly overwrite everything).

**Approach:** persist prior `ccPurchasePrice` per gift card; on next sync, compare new amount vs persisted; if only one card changed, log a `[cc/payment-delta] giftCard N: $X → $Y` line and apply.

### CardCenter — move "Add Card" button to top of GiftCards section
Currently when cards exist, the Add Card button is below them and the new submit-flow buttons; it should sit near Copy + Submit at the top.

### Firefox — re-audit data-entry inputs site-wide for the input issue
User reports the Firefox card-number entry issue is back. Don't fix only the one spot — go through every text input on the tracker (orders, cards, settings, BFMR, BG, CC) and confirm the React controlled-input pattern is right + that we're not losing characters under Firefox autofill or IME composition.

---

### BFMR — submission review UI on order detail (split-shipment safe) — #15

Scope locked 2026-06-28 with user. Build a section at the bottom of the order detail page (under the existing reservations block) that lets the user assemble the `tracker_data` array by hand and submit to BFMR.

**UI shape (per linked BFMR reservation on the order):**
```
BFMR Reservation: iPad 11 128gb Blue ×3   ($299 ea)   [Submit to BFMR]
┌──────────────────────────────────────────────────┐
│ Qty [3]  Tracking: [____________________  ▼]    │  [Split]
└──────────────────────────────────────────────────┘
Allocated 3 of 3 ✓
```
After Split:
```
┌──────────────────────────────────────────────────┐
│ Qty [2]  Tracking: [9339...3497482  ▼]   [×]    │
│ Qty [1]  Tracking: [9339...4883161  ▼]   [×]    │
└──────────────────────────────────────────────────┘
```

**Rules:**
- Default: one row per reservation at the **remaining unsubmitted qty** (do **not** auto-split into qty=1 rows even if multiple tracking numbers exist — user controls splits)
- Qty per row is user-editable; **partial submits are allowed** — sum of row qtys must be ≥1 and ≤ remaining qty (Submit blocked only on over-allocation or zero)
- After a partial submit, the remaining qty stays on the reservation; user can come back later to submit the rest when those packages ship
- Tracking dropdown is populated from `order.trackingNumbers` (the scraped list), with paste-as-text fallback
- One submit button per reservation (independent submits per reservation row)
- If order has 2 BFMR reservations (different SKUs), show 2 stacked blocks
- "Remaining qty" derives from `reservation.qty − sum(already-submitted shipment rows for this reservation)`; refresh after each submit

**API contract** (`POST /api/bfmr/submit-tracking` server-side, fans out to BFMR's `POST /api/my-tracker`):
```json
{
  "reservationId": "<our internal reservation id>",
  "rows": [
    { "qty": 2, "trackingNumber": "9339...3497482" },
    { "qty": 1, "trackingNumber": "9339...4883161" }
  ]
}
```
Server builds the BFMR payload with `id`/`PID`/`my_tracker_id`/`deal_id`/`item_id`/`order_id` from the linked reservation row, one tracker_data entry per row with distinct `rowIndex`.

**Out of scope (until per-shipment scraping lands):**
- Auto-pairing tracking↔item
- Auto-splitting based on tracking count
- Per-item identification when an order has heterogeneous SKUs sharing a reservation

**Builds on:** existing `lib/bfmrSync` + `#31` single-shipment auto-submit (which stays as the fast path when reservation qty == 1 and exactly one tracking exists).

### BFMR — track internal reservation IDs (`Zhg1hImZoxi1GjLUGyvreA==`) to dedupe cancel/recreate
BFMR cancels a reservation and creates a new one with a different internal token when the user changes status. We've been counting both as separate reservations → commitments page shows "20/16" over-committed when 4 are fulfilled. Persist the BFMR-side reservation token and dedupe on it.

### BFMR — picker: only show reservations without order numbers when no order-# match
On the order detail's "Available reservations" picker, when no reservation matches the order number, show only reservations whose `order_id` field is empty (those are the ones genuinely waiting for assignment).

### BFMR — don't sync cancelled or closed reservations
Filter `cancelled` / `closed` statuses out at sync time so they never reach the linker.

### BFMR — existing reservation with tracking + order_id should auto-link silently
If we have a reservation whose `order_id` and `tracking_number` already match an order on our side, link without prompting the user to re-enter tracking.

### BFMR — order imported from BFMR flagged "no reservation"
User: "if an order is imported from BFMR, we obviously have a reservation." Audit the BFMR import path and ensure the link is created at import time (or the flag's `where` clause excludes BFMR-source orders).

---

### BG commitments — expanded quantity not always syncing
User raised an Acer Chromebook commitment from 8 to 10; tracker still shows old assignment math. Sometimes new commitments appear immediately, sometimes not.

**Need from user:** Confirm whether running "Resync Groups" after expanding fixes it (suggests we're not picking up changes to existing commitments — only newly-created ones). If yes, the BG commitment sync needs to upsert on commitment id, not just insert.

### BG commitments — display math: assigned + fulfilled don't add up
Same Acer item: "2 fulfilled · 6 assigned" on a 10-cap commitment with 3 assigned orders × qty 2 = 6 → that's 6 assigned, plus 2 fulfilled = 8, leaving 2 unaccounted in the display. Either the math is wrong or the data has phantom rows.

### BG commitments — ASUS TUF showing 20/16 over-committed when 4 fulfilled
User theory: "once we have items checked in it's reducing the reserved capacity and it looks like we're over capacity." If fulfilled qty is also being counted *against* remaining capacity (instead of against the cap), the denominator shrinks → display shows over-commit. Audit `app/commitments/page.tsx` math.

### BG commitments — linking doesn't always update salePrice
The 2026-06-23 diagnostics (`[commit-recalc]` log) and locked-flag respect should explain most cases. But user reports it's still inconsistent.

**Verify after next link:**
```
docker logs --tail 200 reselling-app-1 2>&1 | grep '\[commit-recalc\]' | tail -20
```
If the skip line shows `locked=false` and `would-be=$X` matches what you expect, it's a UI cache issue (Next.js router.refresh missing somewhere). If `count=0` but the order isn't locked, it's a Prisma where-clause bug.

### BG status flow — paid/processed counts don't match BG portal
Need to walk through the data flow: BG portal numbers → BG receipt API → `lib/bgSync.ts` → `Order.bgPaidAmount` / `salePriceSynced`. Probably caused by Phase-4 fuzzy-match orders being missed.

**Blocker — need from user:** Pick one order where the tracker says "paid" but the BG portal shows different (or vice versa). I'll trace it end-to-end. Order number is enough.

### BG commitment matching Phase 4 — receipt fuzzy match (sale-price + commitment slot)
When a BG receipt comes in with no exact tracking match, fall back to sale-price + commitment slot match. Helps when tracking was entered after BG already processed.

---

### Orders page — multi-select status filter
"would be helpful if i could select partial and pending orders at the same time, for example." Replace single-select with a multi-select chip-style filter; combine selected statuses with OR.

### Order detail — second Save button at top of page
Mirror the bottom Save button at the top so long forms don't require scrolling to save.

### Orders — exclude store-pickup orders from sync (girlfriend's ask)
**Need from user:** How do you currently identify a store-pickup order at the merchant level?
- Walmart: shipping address contains the user's local Walmart, or the tracking number equals the order number (the `55…` Walmart store-deliver pattern we already special-case), or some other field?
- Amazon: usually has a different shipping address or no tracking and "Pickup from Whole Foods"
- Costco: warehouse-pickup is in the order line item's `carrierItemCategory`?

Tell me how *you* know it's pickup when you look at one, and I'll wire it into the scraper to set a `pickup: true` flag and a UI toggle to exclude from sync/analytics.

---

### Tracker UI — keep "Resync Groups" status visible (don't auto-dismiss)
The scrape-status popup currently auto-dismisses 30s after `SYNC_DONE`. User wants it to stay until manually dismissed.

### Tracker UI — add status updates during Resync Groups (currently just sits)
Style of message matching the per-platform "syncing…" banner the scrape produces — break "Resync Groups" into BG / BFMR / CC phases with progress.

### Tracker UI — persistent /sync-history link (not only via banner)
Currently you can only reach `/sync-history` by clicking a banner card. Add a nav link.

### /sync-history — per-merchant summary still says "updated" when it should say "verified"
The 2026-06-23 `verified` count is wired through `/api/import` → extension banner, but the `/sync-history` page summary card still uses old labels.

### Manual tracking save → false "not in group" flag (race condition)
User saves a manual tracking → form reloads → flag fires before BG submit completes. Two options: (a) delay the reload until `autoSubmitTrackingForOrders` resolves, or (b) optimistically suppress the flag for ~3s after save. Recommend (a) — cleaner.

---

### Amazon — Business orders synced with "no buyer" and suspect order numbers
Reported examples: `113-4363476-8740210`, `113-6686166-5984259`, `113-1708980-4429809`. The `113-` prefix is consistent (Amazon Business orders). The scraper is picking them up but not capturing buyer / payment.

**Blocker — need from user:** Open one of these Amazon Business order pages and copy: (a) the URL shape, (b) what the payment-method block looks like in markup (might differ from consumer Amazon). The buyer-name pattern probably also differs.

### Amazon — handle partial order cancels
**Need from user:** Sketch the case for me — does Amazon show the original total with one line struck out, or update the order total? Want a screenshot or paste of the markup.

### Amazon sync triggered in Firefox opens Amazon tab in Chrome
**Likely cause:** when Firefox extension and Chrome extension are both installed pointing at the same tracker, both poll the command queue and the Chrome one wins for `SYNC_AMAZON`. Fix: include `browserId` in the extension's poll request so the tracker can dispatch to the right browser, or have the tracker queue browser-specific commands.

---

### Extension — pop-out window broken in Firefox
`moz-extension://…/popup.html?standalone=1` returns "File not found". The pop-out button calls `chrome.windows.create({ url: chrome.runtime.getURL('popup.html?standalone=1') })`. The Firefox build's `popup.html` is at `popup/popup.html`, not the root. Fix: pass the right path per browser, or move popup.html.

### Centralized API error log (with per-user view)
Capture every BG / BFMR / CC / Costco non-2xx response and surface them under a "API Errors" page on the tracker, filterable by user. Each row: timestamp, group, endpoint, status, response body, related order if known.

### Settings page cleanup
Reorganize the settings page.

**Blocker — need from user:** What's bothering you about it right now? Sections that should be grouped together / hidden behind a "Dev" toggle?

### Amazon delayed-shipping auto-apply
Detect Amazon's "Arriving by [date]" / delayed-shipping signal.

**Blocker — need from user:** Paste the HTML of an Amazon order currently in delayed-shipping state — the chunk with the delay banner. Need the stable DOM hook.

### Costco scraper auth-token refresh + login flag
Confirmed error message: `no oauth token, hard refresh the costco…`. The intercepted access-token grab from `src/background/index.ts` returns null when the user's session has rolled. Need to: (a) detect this case in the content script, (b) attempt `acquireTokenSilent` via the MSAL helper we already have, (c) if that fails, set a `costcoLoginRequired` flag in storage and surface "Costco login required" on the tracker banner. Pause auto-sync until the user re-auths.

### In-UI update button via Unraid webhook
Replace SSH `./update.sh` with a button.

**Blocker — need from user:** Is User Scripts + a webhook plugin installed on Unraid? If yes, paste the webhook URL pattern. If no, decide between (a) installing User Scripts + webhook plugin or (b) a docker-socket exec approach.

### Project folder cleanup
22 stale `resell-tracker-extension-{chrome,firefox}-1.1.5x.{xpi,zip}` files in `~/Desktop/GitHub Projects/` from old releases. Safe to delete all versions older than the current GitHub release (`v1.1.57`) since the originals + signed artifacts are all attached to the GH release.

**Command to run when you say go:**
```
cd "/Users/penndalton/Desktop/GitHub Projects" && \
  find . -maxdepth 1 \( -name 'resell-tracker-extension-chrome-1.1.5*.zip' -o -name 'resell-tracker-extension-firefox-1.1.5*.xpi' \) \
  -not -name '*1.1.57*' -print -delete
```

---

## Recently shipped (kept for context)

- **BG commitment Phase 5: auto-fill `bgExpectedPayout`** — `lib/commitmentSalePrice.ts` writes `bgExpectedPayout = salePrice` (commitment total) on every link change.
- **Payment Due Date field** — `overdueAt` (date picker labeled "Payment Due Date" in `OrderForm.tsx`).
- **Mileage Program Designator on Cards** — `milesProgram` field on `CreditCard`, badge on card display.
- **Mileage / Points Earned Tracking** — per-order points column + `/analytics` miles total and `milesByProgram` breakdown.
- **BigSkyBuyers scraping** — content script + background dispatch.
- **CardCenter API integration** — credentials, submit / sync-payments / reserve / fulfill endpoints, per-card `ccPurchasePrice`. Orphan back-fill matches by `cardNumber` suffix + (2026-06-23) merchant+value tier-3 fallback.
- **CardCenter ID-mismatch fix** — sync-payments now matches `listing.giftCard.id` (not `listing.id`) which never matched anything.
- **BG ↔ Walmart matching** in `lib/bgSync.ts` — tracking-based receipt match, salePrice sync, auto-lock on full payment.
- **BG commitment linker** on order detail (Phase 3) + `[commit-recalc]` diagnostic logs.
- **BFMR reservation linker** + browse-all-unlinked fallback.
- **Address-blocked quarantine flow** — `app/orders/blocked`, Allow/Delete UI, excluded from analytics.
- **Sync history** with per-order field diffs (`app/sync-history`), clickable from extension's done banner.
- **Auto-submit tracking pipeline** (`lib/autoSubmitTracking.ts`) — fires from import, PATCH, PUT, and `/api/bg/backfill-tracking`.
- **Payment-info widget** on order detail (Expected / Paid / Reference / Status).
- **Manual payment marking** — Lock button + `salePriceSynced`.
- **Per-order payment status** badge (Paid / Pending / Overdue).
- **Extension popup** flags only extension updates.
- **Scrape tab management** — current-window open, never reuses retailer tabs, auto-closes after scan, recovers on tab-closed.
- **Verified vs Updated** count in tracker banner.
- **Locked-order respect** across all reservation/payment write paths.

## Notes for next session

- Uncommitted on disk: schema + sync-payments rework for `ccListingId` transition. Needs the submit/route.ts piece before shipping.
- After last commit (2882d8c), verify `[cc/sync-payments]` shows `N matched by ccGiftCardId > 0` for payments containing your cards (was 0 before the listing.giftCard.id fix).
- `/api/bg/backfill-tracking` accepts session cookie OR `X-Extension-User-Id` header; with neither, fans out across every user with eligible orders.
