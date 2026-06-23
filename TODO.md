# Resell Tracker — TODO

Last updated: 2026-06-23

## Active

### Settings page cleanup
Reorganize the settings page — needs user direction on what to consolidate and where new sections should land. **Blocker:** waiting on direction.

### Amazon delayed-shipping auto-apply
Detect Amazon's "Arriving by [date]" / delayed-shipping signal and apply the corresponding internal delay flag automatically. **Blocker:** need a sample of the delayed-order detail HTML so we know which DOM hook to use.

### Payment Due Date Field
Add an optional `paymentDueAt` date field on orders.
- When set and date has passed, auto-mark order overdue (cron or on-load check)
- Visible in order form as "Payment Due" date picker
- Supersedes the 14-day auto-overdue logic for that order

### BFMR submission review UI (split-shipment safe)
BFMR exposes one row per shipment for split orders; auto-matching by order_id risks pushing the wrong tracking. Need a review UI where the user confirms which tracking goes to which shipment row before push.

### Tracking-verification flag
After auto-submit, poll the group's tracking-acceptance status (BG, BS, BFMR) and surface accepted/rejected state on the order. Currently `trackingSubmittedToBg=true` only means "we sent it," not "they accepted it."

### BG commitment matching Phase 4 + 5
- **Phase 4:** receipt fuzzy match — when a BG receipt comes in with no exact tracking match, fall back to matching by sale-price + commitment slot.
- **Phase 5:** auto-fill `bgExpectedPayout` from the linked commitment so PaymentInfo shows the right expected value without manual entry.

### Optional: in-UI update button via Unraid webhook
Replace SSH-into-host `./update.sh` with a button on the tracker that hits an Unraid webhook to run the same script.

### CardCenter paid values not showing on submitted cards
User reports submitted CC cards still missing paid value. `submit/route.ts` populates `ccPurchasePrice` from `result.ccGiftCardIds` match by code suffix; `sync-payments` back-fills orphans by `cardNumber` suffix → merchant+value (tier-3 fallback added 2026-06-23 for cards uploaded directly via CC's website).

**Verify after deploy** — run "Resync Groups" on `/orders`, then:
```
docker logs --tail 500 reselling-app-1 2>&1 | grep '\[cc/sync-payments\]' | tail -60
docker logs --tail 500 reselling-app-1 2>&1 | grep '\[cc/submit\]' | tail -40
```

### Diagnose commitment-link salePrice miss on order 200014749763670
User reported linking a BG commitment to this order didn't update salePrice. Added `[commit-recalc]` diagnostic logs that explain locked status / current value / would-be value.

**Verify after deploy** — re-link a commitment on the order, then:
```
docker logs --tail 200 reselling-app-1 2>&1 | grep '\[commit-recalc\] order 200014749763670' | tail -5
```

---

## Recently shipped (kept for context)

- **Mileage Program Designator on Cards** — `milesProgram` field on `CreditCard` (e.g. "Amex MR", "Bilt", "Alaska", "Delta SkyMiles"), input on `/cards`, badge on card display.
- **Mileage / Points Earned Tracking** — per-order points column on `/orders` derived from card + merchant rates; `/analytics` shows `miles` total and `milesByProgram` breakdown current-vs-comparison.
- **BigSkyBuyers scraping** — content script at `src/content/bigskybuyers.ts`, background `SYNC_BIGSKY` command, dedicated push endpoint.
- **CardCenter API integration** — credentials in Settings, submit / sync-payments / reserve / fulfill endpoints, per-card `ccPurchasePrice` populated. Orphan back-fill matches by `cardNumber` suffix for cards uploaded directly via CardCenter's website.
- **BG ↔ Walmart matching** in `lib/bgSync.ts` — tracking-based receipt match, salePrice sync, auto-lock on full payment.
- **BG commitment linker** on order detail (Phase 3).
- **BFMR reservation linker** + browse-all-unlinked fallback.
- **Address-blocked quarantine flow** — `app/orders/blocked`, Allow/Delete UI on blocked orders, excluded from analytics.
- **Sync history** with per-order field diffs (`app/sync-history`), clickable from the extension's done banner.
- **Auto-submit tracking pipeline** (`lib/autoSubmitTracking.ts`) — fires from import, PATCH, PUT, and the new `/api/bg/backfill-tracking` endpoint.
- **Payment-info widget** on order detail (Expected / Paid / Reference / Status).
- **Manual payment marking** — Lock button + `salePriceSynced`.
- **Per-order payment status** badge (Paid / Pending / Overdue).
- **Extension popup** flags only extension updates; dashboard flags dashboard updates.
- **Scrape tab management** — opens in current window, never reuses retailer tabs in other windows, auto-closes after scan, recovers on tab-closed-mid-scrape.
- **Verified vs Updated** count in sync-history and tracker banner.
- **Locked-order respect** across all reservation/payment write paths.

## Notes for next session

- After deploy, verify `[bg-submit/put]` fires when editing tracking on the form (PUT path was previously missing the trigger).
- After v1.1.57, verify `[import] auto-assign … → card N` lines start appearing on scrape (paymentLast4 was being dropped before POST).
- `/api/bg/backfill-tracking` accepts session cookie OR `X-Extension-User-Id` header; with neither, fans out across every user with eligible orders (single-user setup just works via host curl).
