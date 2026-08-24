-- Remove the CashbackMonitor (CBM) feature set. PortalRate held per-merchant
-- cashback-portal rates scraped from cashbackmonitor.com via the browser
-- extension's SCRAPE_CBM command. The feature is being retired entirely, so
-- the table goes with it.
--
-- DESTRUCTIVE: this drops all stored portal rates. The data is disposable —
-- it was purely a scraped cache of public cashback rates, re-derivable from
-- the source at any time and never referenced by orders, payouts, or money.
DROP TABLE "PortalRate";
