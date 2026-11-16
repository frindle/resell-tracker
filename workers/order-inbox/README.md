# order-inbox

Cloudflare Email Worker for the resell-tracker order inbox. Mail sent to
per-user addresses on an orders subdomain is stored raw in KV for 30 days; the
tracker pulls it over an authenticated HTTP API and deletes it after import.
A deleted message is kept in an archive for 7 days, in case an import went
wrong and the email is needed again.

API (all need `Authorization: Bearer <PULL_TOKEN>`):

- `GET /messages?cursor=&limit=` (limit max 100) -> `{ messages: [{ id, to, from, size, receivedAt }], cursor, complete }`
- `GET /messages/:id` -> raw MIME (`message/rfc822`)
- `DELETE /messages/:id` -> 204 (moves it to the 7-day archive; `?purge=1` deletes it outright)
- `GET /archive?cursor=&limit=` -> same shape as `/messages`, plus `processedAt`
- `GET /archive/:id` -> raw MIME
- `DELETE /archive/:id` -> 204 (deletes it now)

Cost: Email Routing is free. On the Workers Free plan KV allows 1,000 writes,
1,000 deletes and 1,000 lists a day; each imported email uses one write for the
archive and polling every 5 minutes uses about 288 lists a day.

## Deploy (owner runs these)

```sh
cd workers/order-inbox
npx wrangler kv namespace create ORDER_MAIL      # paste the id into wrangler.toml
npx wrangler secret put PULL_TOKEN               # long random string
npx wrangler deploy
```

Then in the Cloudflare dashboard:

1. Enable Email Routing on the orders subdomain (e.g. `orders.example.com`).
2. Add one literal routing rule per user address (e.g. `penn@orders.example.com`)
   with action "Send to a Worker" -> `order-inbox`. Subdomains have no
   catch-all, so every address needs its own rule.

In the tracker: Settings > Order Email Inbox > Cloudflare, enter the worker URL
and the pull token, Test Connection, Save. Each user then lists their orders
address under Import > Email Routing.

## addy.io rule webhooks

addy.io aliases can't forward to an orders address without a verified reply
from it, so instead an addy rule (sender contains amazon/walmart/costco/...,
forwards only, action "Send a webhook" with body and headers) POSTs each
matching email to `https://<worker>/addy/<local>` (e.g. `/addy/penn`). The
worker checks `X-Addy-Signature` (HMAC-SHA256 of the raw body with the addy
account's webhook secret), rebuilds a text/html MIME message addressed to the
user's orders address, and stores it like routed mail, so the tracker imports
and routes it with no changes. Attachments are never included by addy.

```sh
npx wrangler secret put ADDY_WEBHOOK_SECRET          # Rules > More info in addy
# optional per-user secret when users have separate addy accounts:
npx wrangler secret put ADDY_WEBHOOK_SECRET_MELODY
```

and set the plain var `ADDY_RECIPIENTS` to the orders addresses the path may
name, comma separated (`penn@orders.example.com,melody@orders.example.com`).
Unknown paths and missing secrets return 404, a bad signature 401 (addy treats
4xx as final), KV errors 5xx (addy retries). Retries reuse addy's payload id,
so they overwrite instead of duplicating.

## Tests

`node --test src/handlers.test.js`
