# TASK: bfmr-sync-orders-paginate

## Confirmed defect (observed, not suspected)

Confirmed live in `app/api/bfmr/sync-orders/route.ts`. The `fetch: true` block
(the server-side path the 6-hourly auto-sync scheduler uses, since it has no
browser to POST tracker items) calls `getMyTracker`, which returns **PAGE 1
ONLY** (`page_size: 200`). The account has ~700-750 tracker rows, so
`sync-orders` only ever sees the first 200 rows in BFMR's default sort; orders
past position 200 are never created/updated locally for days-to-a-week, silently
(no error, no log line).

`lib/bfmr.ts` already exports a paginating `getMyTrackerAll` (line 175) that
loops `page_no` 1..N until BFMR returns a short page. `sync-reservations`
(`app/api/bfmr/sync-reservations/route.ts:47`) already uses it correctly.
`sync-orders` was simply never migrated to it.

Current line (verified): `app/api/bfmr/sync-orders/route.ts:42` reads
`items = await getMyTracker(`, preceded by
`const { getMyTracker } = await import('@/lib/bfmr');`.

## Entry point

`app/api/bfmr/sync-orders/route.ts:39-45` -- the single `fetch: true` block. This
is the ONLY change site.

## Required change

In `app/api/bfmr/sync-orders/route.ts`, inside the `fetch: true` block, replace
the single-page `getMyTracker` with the paginating `getMyTrackerAll`:

1. The dynamic import
   `const { getMyTracker } = await import('@/lib/bfmr');`
   becomes
   `const { getMyTrackerAll } = await import('@/lib/bfmr');`
2. The call
   `items = await getMyTracker( ... )`
   becomes
   `items = await getMyTrackerAll( ... )`

Keep the SAME filter object argument (`{ quick_filter: 'all', page_size: 200,
start_date: start, end_date: end }`) and the same creds argument. `page_size`
stays 200 -- it is now the per-page size the paginator loops over, not a cap on
the total. Do NOT edit `lib/bfmr.ts` (the paginator already exists and is
tested), and do not change anything else in the route.

Behaviour that must NOT change:
- The block still runs only when `items.length === 0 && body.fetch === true` and
  both `bfmr_api_key` and `bfmr_api_secret` settings are present.
- The `start_date` / `end_date` 90-day window and `quick_filter: 'all'` are
  unchanged.
- All downstream grouping/matching/create/update logic below the block is
  untouched.

## Must contain

- `getMyTrackerAll`

(The gate holds the reference impl against this list. `getMyTrackerAll` is absent
from the baseline route -- it only appears once the fetch block is migrated.)

## Scope

Only edit `app/api/bfmr/sync-orders/route.ts`; do not edit `verify.sh`,
`verify.sync-orders.test.mts`, `verify.tsconfig.json`, `.verify-next-headers.ts`,
`check_literals.py`, `refimpl.py`, `lib/bfmr.ts`, or `TASK.md`.
verify.sync-orders.test.mts is the test fixture -- changing it invalidates the
check.

## How the verify proves it (relevance)

`verify.sync-orders.test.mts` calls the REAL exported `POST` handler and stubs
ONLY the transport boundary (`globalThis.fetch`, which `lib/bfmr`'s `bfmrFetch`
calls). It serves multiple full pages then a short page and asserts the route
(a) issues one tracker request per page (`page_no` 1..N until the short page,
i.e. more than one request) and (b) ingests EVERY row (response `total` far
exceeds one 200-row page). On the current single-page `getMyTracker` this is
always 1 request / total 200, so all three cases FAIL at baseline and PASS after
the swap. Do not try to satisfy the verify by editing the test or lib/bfmr --
only the route change makes it pass.

## Loop instruction

Run `bash verify.sh` after every edit and keep editing
`app/api/bfmr/sync-orders/route.ts` until it prints `VERIFY_OK`.
