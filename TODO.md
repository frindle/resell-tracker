# Resell Tracker — TODO

## Mileage / Points Earned Tracking
Track credit card miles/points earned per order and in aggregate.
- Orders already store `cashbackAmount` and card + merchant rates, so points per order can be computed
- Add a points/miles summary to the Analytics page (total pts earned, by card, by merchant)
- Add a per-order points column to the orders table (derived from card rate × cost)
- Consider a dedicated "Miles" page showing lifetime earn broken down by card

## Payment Status per Order
Show whether each buying group has paid for a given order.
- Add a `paymentStatus` field (or derive from `salePrice` / `overdueAt`) visible on the orders list
- Show a badge per order: Paid / Pending / Overdue
- Filter orders by payment status (extend the existing Overdue filter)
- Surface the linked BuyingGroup/BFMR receipt ID on the order detail page for traceability

## BuyingGroup ↔ Walmart order matching
Match BuyingGroup receipts to Walmart orders using tracking numbers so payouts can be synced automatically (same flow as BFMR sync).

**Status:** Tracking number matching is now implemented in `lib/bgSync.ts`. Requires tracking numbers to be present on orders (synced via Chrome extension or manually entered).

**Remaining:**
- Verify tracking numbers are being captured by the Walmart scraper and stored on orders
- Test end-to-end: BG receipt → tracking match → salePrice update
