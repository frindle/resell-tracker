# Resell Tracker — TODO

## BuyingGroup ↔ Walmart order matching
Match BuyingGroup receipts to Walmart orders using tracking numbers so payouts can be synced automatically (same flow as BFMR sync).

**Blockers to resolve first:**
- Walmart order export doesn't include tracking numbers — need to find a Walmart export or Chrome extension that includes them
- Once we have tracking numbers on Walmart orders, store them on the Order model
- BuyingGroup receipts have `tracking_number` — use that as the match key instead of order number
- Build a BuyingGroup → orders sync (similar to BFMR sync-orders) that fills in sale price from `cashback_amount` or `total_amount`
