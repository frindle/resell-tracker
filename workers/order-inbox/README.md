# order-inbox

Cloudflare Email Worker for the resell-tracker order inbox. Mail sent to
per-user addresses on an orders subdomain is stored raw in KV for 30 days; the
tracker pulls it over an authenticated HTTP API and deletes it after import.

API (all need `Authorization: Bearer <PULL_TOKEN>`):

- `GET /messages?cursor=&limit=` (limit max 100) -> `{ messages: [{ id, to, from, size, receivedAt }], cursor, complete }`
- `GET /messages/:id` -> raw MIME (`message/rfc822`)
- `DELETE /messages/:id` -> 204

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

## Tests

`node --test src/handlers.test.js`
