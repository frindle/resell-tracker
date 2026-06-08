# Resell Tracker

A self-hosted dashboard for tracking reselling profit & loss across multiple platforms, buying groups, and users.

## Features

- **Dashboard** — P&L stats by month, quarter, YTD, and all-time
- **Order management** — manual entry, bulk CSV import (Amazon & Walmart), Gmail sync
- **Multi-user** — separate order history and settings per profile
- **Buying groups** — track payouts per group with full order history
- **BuyingGroup.com** — live deals browser with cashback spread calculator and payout history
- **BFMR** — tracker view, active deals, and shipment insurance
- **Analytics** — revenue, cost, cashback, and profit breakdowns with filtering
- **Credit card cashback** — auto-calculate cashback per order by card rewards rate
- **Address rules** — auto-assign orders to buying groups by shipping address pattern
- **Blocked addresses** — skip personal/home shipments on import
- **Deduplication** — normalize order numbers (strips non-digits) to prevent duplicate imports

## Tech Stack

- [Next.js 16](https://nextjs.org) (App Router, standalone output)
- [Prisma 7](https://prisma.io) with `@prisma/adapter-better-sqlite3`
- [SQLite](https://sqlite.org) via [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)
- [Tailwind CSS v4](https://tailwindcss.com)
- Docker + docker-compose (macvlan)

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

## Configuration

All integrations are configured in **Settings** after first login.

| Setting | Purpose |
|---|---|
| BFMR API Key + Secret | BuyForMeRetail tracker and deals |
| Gmail address + App Password | Auto-import order emails |
| BuyingGroup.com email + password | Receipts and live deals |

Gmail requires a [Google App Password](https://myaccount.google.com/apppasswords) (not your regular password). 2FA must be enabled on the Google account.

---

## Changelog

### Unreleased

- Quick-assign unknown addresses to buying groups on batch import

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
