# Resell Tracker

A self-hosted dashboard for tracking reselling profit & loss across multiple platforms, buying groups, and users, with a companion browser extension for automatic order syncing and cashback rate scraping.

## Features

- **Dashboard** — P&L stats by month, quarter, YTD, and all-time
- **Order management** — manual entry, bulk CSV import (Amazon & Walmart), Gmail sync, and automatic sync via browser extension
- **Multi-user** — separate order history and settings per profile
- **Buying groups** — track payouts per group with full order history
- **BuyingGroup.com** — live deals browser with cashback spread calculator and payout history
- **BFMR** — tracker view, active deals with merchant links and cashback rates, and shipment insurance
- **Portal rates** — automatic CBM (CashbackMonitor) scraping via extension; hover any merchant link to compare all portal rates
- **Analytics** — revenue, cost, cashback, and profit breakdowns with filtering
- **Credit card cashback** — auto-calculate cashback per order by card rewards rate
- **Address rules** — auto-assign orders to buying groups by shipping address pattern
- **Blocked addresses** — skip personal/home shipments on import
- **Deduplication** — normalize order numbers (strips non-digits) to prevent duplicate imports
- **Browser extension** — syncs Amazon, Walmart, Costco, and BigSky Buyers orders; scrapes CashbackMonitor rates; accepts commands from the tracker

## Tech Stack

- [Next.js 16](https://nextjs.org) (App Router, standalone output)
- [Prisma 7](https://prisma.io) with `@prisma/adapter-better-sqlite3`
- [SQLite](https://sqlite.org) via [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)
- [Tailwind CSS v4](https://tailwindcss.com)
- Docker + docker-compose (macvlan)

---

## Docker Deployment (Unraid / self-hosted)

### docker-compose.yml

```yaml
services:
  app:
    build: .
    networks:
      br0:
        ipv4_address: ${CONTAINER_IP}  # set in .env
    volumes:
      - /mnt/user/appdata/reselling:/data
    environment:
      DATABASE_URL: file:/data/resell.db
    restart: unless-stopped

networks:
  br0:
    external: true
    name: br0
```

### First deploy

```bash
git clone https://github.com/frindle/resell-tracker
cd resell-tracker
echo "CONTAINER_IP=10.0.x.x" > .env   # replace with your desired static IP
docker-compose build
docker-compose up -d
```

### Update

```bash
git pull && docker-compose build && docker-compose up -d
```

The container runs `prisma migrate deploy` automatically on startup before starting the server.

## Local Development

```bash
npm install
npx prisma generate
npx prisma migrate dev
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## User Guide

### First-Time Setup

1. Navigate to your tracker URL and create the first user account.
2. Open **Settings** and configure your integrations (see table below).
3. Install the browser extension (see [resell-tracker-extension](https://github.com/frindle/resell-tracker-extension)).
4. In the extension options, set your Tracker URL, API Key, and select your user.

### Settings

All integrations are configured in **Settings** after first login.

| Section | Fields | Purpose |
|---|---|---|
| BFMR | Email + Password | BuyForMeRetail tracker, deals, and auto-cancel. API key/secret are auto-fetched on save. |
| BuyingGroup.com | Email + Password | Receipt sync and live deals browser |
| CardCenter | Email + Password | Gift card submission and payment sync |
| Gmail | Address + App Password | Order confirmation email parsing |
| Pushover | User Key + App Token | Push notifications for overdue orders |
| Portal Rates | Merchant / Portal / Rate | Manual cashback rate entries (auto-filled by extension) |
| Browser Extension | — | Queue commands and view recent command status |

### Orders Page

The main order list with filtering, sorting, and bulk actions.

**Filters:** Platform (Amazon / Walmart / Other), status, date window, buyer/group, and free-text search.

**Sync buttons** (top right):
- **Sync Amazon / Sync Walmart / Sync Costco** — queues a sync command for the browser extension. The extension picks it up on its next poll (within 60 seconds) and opens the retailer page to scrape new orders.
- **Resync Groups** — re-runs BuyingGroup.com receipt sync, BFMR payout sync, and CardCenter payment sync server-side (no extension needed).
- **Import** — manual CSV import for Amazon and Walmart order exports.

**Bulk actions** (select orders via checkbox):
- Submit tracking numbers to BuyingGroup.com
- Mark selected orders as paid
- Delete selected orders

### BFMR Deals Page

Live deal browser pulling from BFMR's active deal list.

**Sort order:**
1. Deals with at least one in-stock merchant appear first
2. Within that: above-retail deals sorted by highest retail price
3. Then below-retail deals sorted by highest retail price, tie-broken by closest to break-even

**Merchant links** appear below each deal title showing all available buy-from stores. Green border + ✓ = in stock.

**Cashback rates:** Next to each merchant button you'll see the best portal cashback rate (when scraped). Click `cbm↗` to open CashbackMonitor directly, or hover over it to see all portal rates for that merchant in a popup.

**↺ rates button** — re-fetches portal rates from the database without a full page reload. Use this after the extension finishes a CBM scrape to see the new rates.

**Reserve button** — opens the reservation panel for that deal, letting you select an item and quantity, then reserve or add a watcher.

### BFMR Tracker Page

Shows all tracked BFMR orders synced from your account. Columns include status, order amounts, shipment details, and insurance value.

**Cancel button** — available on reserved or purchased items. Calls the BFMR cancel API and marks the order as cancelled in the local DB.

### Browser Extension

The [companion extension](https://github.com/frindle/resell-tracker-extension) runs in the background and communicates with your tracker.

**Setup:**
1. Install from the GitHub releases page (Chrome: load unpacked from `dist/` zip; Firefox: install the `.xpi`)
2. Click the extension icon → ⚙ Settings
3. Enter your Tracker URL (e.g. `https://reselling.yourdomain.com`)
4. Enter your API Key (find it in tracker Settings → Browser Extension)
5. Select your user from the dropdown

**What it does automatically:**
- Polls your tracker every 60 seconds for queued commands
- Executes sync and scrape commands in the background
- Reports results back to the tracker

**Commands (queued from Orders page or Settings):**
| Command | Trigger | What happens |
|---|---|---|
| Sync Amazon | Orders page → Sync Amazon | Opens amazon.com/your-orders, scrapes recent orders, imports new ones |
| Sync Walmart | Orders page → Sync Walmart | Opens walmart.com/orders, scrapes and imports |
| Sync Costco | Orders page → Sync Costco | Opens costco.com account page, scrapes orders and receipts |
| Sync BigSky | Settings → Sync BigSky | Opens bigskybuyers.com, scrapes payout data |
| Refresh CBM Rates | Settings → Refresh CBM Rates | Opens CashbackMonitor for each active BFMR merchant, scrapes portal rates, stores in DB |

**Extension popup** shows the tracker command poll status (last poll time). All sync commands are now initiated from the tracker portal rather than the popup.

### Portal Rates (Cashback Monitor)

Portal rates are cashback percentages from shopping portals (Rakuten, TopCashback, etc.) scraped from CashbackMonitor.

**To refresh rates:**
1. In Settings → Browser Extension, click **Refresh CBM Rates** — this queues a `SCRAPE_CBM` command
2. The extension opens CashbackMonitor for each active BFMR merchant in background tabs, scrapes rates, and POSTs them to your tracker
3. On the BFMR Deals page, click **↺ rates** to reload the now-populated rates

Rates appear next to each merchant button on the deals page. Hover `cbm↗` to see all portals.

### Buying Groups (Buyers)

Each buyer/buying group has its own page showing order history, payout totals, and expected vs actual payment tracking.

**Resync Groups** (Orders page) runs:
1. BuyingGroup.com receipt sync — matches scanned receipts to orders
2. BFMR full sync — updates statuses and payout amounts
3. CardCenter payment sync — matches CC payments to gift card submissions

### Analytics

Revenue, cost, cashback, and profit breakdowns. Filter by date window (30d / 90d / 6mo / 1yr / all).

---

## Changelog

### 2026-06-14

- **BFMR Deals page overhaul:**
  - Merchant links moved to full-width subrow below deal title
  - In-stock deals sort to top; within groups, sorted by highest retail price (above-retail first, then below)
  - Added Retail price column alongside Value and vs-Retail
  - `cbm↗` link always visible; hover popup shows all portal rates for that merchant
  - Closest-to-break-even tie-breaker for below-retail deals
- **Portal rates (CBM scraping):**
  - Extension now POSTs rates from the background service worker (bypasses cashbackmonitor.com CSP that blocked content script fetch)
  - Extension poll headers include `X-Extension-User-Id` so vendor lookup works without a browser session
  - `/api/bfmr/vendors` falls back to `X-Extension-User-Id` header when no session cookie present
  - `↺ rates` refresh button added to BFMR Deals page
- **Orders page:** Added Sync Amazon / Sync Walmart / Sync Costco buttons that queue extension commands directly from the portal
- **Settings:** Extension command queue table shows last 20 commands with type, status, result, and age; refreshes after queuing
- **Extension popup:** Removed Amazon/Walmart/Costco/BigSky sync rows — syncs now initiated from the tracker portal
- **resolve-link:** Skip redirect-following for known retail domains; extract real destination from snaptheprice.com/fatcoupon.com intermediate redirects
- **Extension v1.1.36**

### 2026-06-13

- BFMR Deals page: pre-fetch deal items in background batches of 5; vendor filter dropdown
- BFMR Deals page: Cancel button on tracker page for reserved/purchased items
- Fix: `/api/portal-rates/bulk` upsert with compound unique key `(merchant, portal, category)`
- Fix: CBM content script always sends `CBM_SCRAPE_DONE` even when no rates found
- Fix: alarm fires immediately on extension install/startup; `lastPoll` recorded at top of poll function
- Fix: `SYNC_AMAZON_ORDER` command deduplication before create
- Fix: `bfmr/vendors` uses correct user ID from session
- Fix: Amazon order sync throws on error instead of returning `{ok:false}` (enables retry logic)
- Fix: `patchCommand` retries 3× with backoff instead of silently swallowing errors
- Extension v1.1.35

### 2026-06-12

- BFMR settings: replace separate API key/secret fields with email+password login (API key/secret auto-fetched and saved on connect)
- Rename `bfmrOrderId` → `groupReferenceId` — generic group reference field used by both BFMR (order ID override) and CardCenter (payment ID)
- CardCenter payment sync: match gift cards by `ccGiftCardId` to payment listings and distribute `bgPaidAmount` per order
- Add CardCenter to "Resync Groups" button on orders page
- Add per-tracking-number value notation on order detail page (`trackingValues` JSON field)
- Hide Gmail integration in settings until parsing is fixed

### 2026-05-29

- Fix first-user setup stuck on "Creating…" (hard redirect after cookie set)
- Simplify login page — adding users moved to Settings → Users
- Add payout history per buying group on the Buyers page
- Add BuyingGroup.com deal payout history (price change timeline)
- Add order deduplication on CSV/email import (normalized order number comparison)
- Add "how far back" selector for Gmail sync
- Auto-assign buying groups from shipping address rules on CSV import
- Fix Docker build — copy pre-built `node_modules` from builder stage to avoid recompiling native modules in runner
- Exclude `tsconfig.tsbuildinfo` from Docker build context

### Earlier

- Multi-user profiles with session cookie auth
- CSV import for Amazon and Walmart orders
- Gmail IMAP sync for order confirmation emails
- Shipping address rules and blocked address patterns
- Email routing rules for multi-user Gmail setups
- BFMR tracker, deals, and test connection
- BuyingGroup.com receipts and live deals browser
- Analytics page with date range filtering
- Credit card cashback auto-calculation
- Buying groups (buyers) with order assignment
