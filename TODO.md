# Resell Tracker — TODO

## Mileage Program Designator on Cards
Add a `milesProgram` field to CreditCard (e.g. "MR" for Amex Membership Rewards, "Bilt", "VS" for Virgin Red, "AS" for Alaska). Display the program abbreviation next to points earned on the orders page and analytics so it's clear which program the miles are going to. User-defined per card.

## Mileage / Points Earned Tracking
Track credit card miles/points earned per order and in aggregate.
- Orders already store `cashbackAmount` and card + merchant rates, so points per order can be computed
- Add a points/miles summary to the Analytics page (total pts earned, by card, by merchant)
- Per-order points column shows `X pts (MR)` using the card's milesProgram label

## Manual Payment Marking
Allow marking an order as paid manually (for cases where BG/BFMR sync doesn't auto-detect).
- Add a "Mark as Paid" button on the order detail/edit page
- Sets `salePrice` + `salePriceSynced = true` or a dedicated `manuallyPaid` flag
- Should also clear `overdueAt`

## Payment Due Date Field
Add an optional `paymentDueAt` date field on orders.
- When set and date has passed, automatically mark order as overdue (cron or on-load check)
- Visible in order form as "Payment Due" date picker
- Supersedes the 14-day auto-overdue logic for that order

## BigSkyBuyers Scraping
Add BigSkyBuyers to the extension as a buying group source.
- Investigate their portal structure (login, order/receipt list, tracking/payout fields)
- Add a `bigskybuyers` content script similar to BuyingGroup/BFMR

## Extension: Popup Status on New Tab
When the extension opens a new tab to reach the Amazon orders page, status updates show on the old tab's popup context, not the new one. Need to route messages through the background worker so the popup always gets them regardless of which tab the content script is on.

## Extension: Dist Zip for Releases
On every release, build and attach a zip of just the `dist/` folder to the GitHub release so it can be downloaded and sideloaded without cloning the repo.

## Payment Status per Order
Show whether each buying group has paid for a given order.
- Add a `paymentStatus` field (or derive from `salePrice` / `overdueAt`) visible on the orders list ✅ done
- Show a badge per order: Paid / Pending / Overdue ✅ done
- Surface the linked BuyingGroup/BFMR receipt ID on the order detail page for traceability

## BuyingGroup ↔ Walmart order matching
Match BuyingGroup receipts to Walmart orders using tracking numbers so payouts can be synced automatically (same flow as BFMR sync).

**Status:** Tracking number matching is now implemented in `lib/bgSync.ts`. Requires tracking numbers to be present on orders (synced via Chrome extension or manually entered).

**Remaining:**
- Verify tracking numbers are being captured by the Walmart scraper and stored on orders
- Test end-to-end: BG receipt → tracking match → salePrice update
