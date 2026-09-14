# TASK: rt-amazon-buybox

## Confirmed defect (observed, not suspected)

confirmed missing capability: no code reads Amazon buy-box seller identity. amazon.js only scrapes past orders (grep of sidecar/src/amazon.js line 749 module.exports shows syncAmazon/syncAmazonOrders/extractIrisLastDigits only; no 'sold by'/'ships from'/buy-box parse). BFMR auto-buy MUST refuse any offer not sold AND shipped by Amazon.com, and must read the offer price. New pure function parseAmazonBuyBox needed.

## Entry point

lib/amazonOffer.ts:1

## Required change

parseAmazonBuyBox(html) returns {soldBy, shippedBy, soldAndShippedByAmazon, price, currency}; soldAndShippedByAmazon is true ONLY when BOTH the ships-from AND sold-by merchant are Amazon.com (Prime/FBA third-party = false); price parsed to a number or null

Create the NEW file `lib/amazonOffer.ts` exporting a pure function:

    export interface AmazonBuyBox { soldBy: string|null; shippedBy: string|null; soldAndShippedByAmazon: boolean; price: number|null; currency: string|null }
    export function parseAmazonBuyBox(html: string): AmazonBuyBox

Rules the tests enforce:
- `soldAndShippedByAmazon` is true ONLY when BOTH the "Ships from" and "Sold by"
  merchants are Amazon.com. A Prime/FBA offer whose seller is a marketplace
  third party (ships from Amazon.com, sold by "ACME Deals LLC") MUST be false.
  "Amazon Warehouse" (used) is NOT Amazon.com -> false.
- Support the modern tabular buy-box markup (`tabular-attribute-name="Ships from"`
  / `"Sold by"`) AND the legacy combined phrase "Ships from and sold by Amazon.com".
- `price` is the first `$1,234.56`-style amount parsed to a Number (commas
  stripped), else null; `currency` 'USD' when a price was found, else null.
- Degenerate input (empty string, no offer markup, missing seller) must NOT
  throw: return soldAndShippedByAmazon=false, price=null, soldBy=null.
- Pure function: no DOM APIs, no network, no imports beyond types.

## Must contain

- `export function parseAmazonBuyBox`
- `soldAndShippedByAmazon`

(The gate holds the reference impl against this list. If the verify goes green
while one of these is absent from the changed files, the verify does not
enforce the spec -- that is a benign verify, caught mechanically.)

## Scope

Only edit `lib/amazonOffer.ts`; do not edit `verify.sh`, `verify.test.ts` or `TASK.md`.
verify.test.ts is the test fixture -- changing it invalidates the check.

## Keep every changed line exercised (relevance)

After the job runs, a mutation check flips/deletes each line you changed and
asks the verify to catch it. A changed line whose every mutant survives --
because no test asserts it -- FAILS the gate even when the fix is correct, and
the review never runs. So do NOT emit an isolated, untested line:
- Fold an unavoidable constant onto a line the test already exercises. Put a
  `timeout=` / a `daemon=True` flag / a small tuning number on the SAME line as
  a header dict, URL, or argument the fixture checks -- never on its own line.
- Prefer falling through to an implicit `return None` over a standalone
  `return None` in an `except:` the tests do not assert.
- If a line genuinely cannot be asserted and cannot be folded, it usually
  should not be a separate line at all -- restructure so it isn't.
This is not about adding bogus assertions for constants; it is about not
leaving a lone line that carries no tested behaviour.

## Loop instruction

Run `bash verify.sh` after every edit and keep editing until it prints
`VERIFY_OK`.
