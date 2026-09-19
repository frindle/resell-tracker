# TASK: rt-walmart555-tracking-fix

## Confirmed defect (observed, not suspected)

CONFIRMED (live, order 930): syncWalmart's per-order fallback only assigns order.trackingNumbers=[order.orderNumber] when detail.isStoreDelivery is true. For a non-store-delivery order where detail.tracking is empty (the only page number was a Walmart-internal 555-prefixed reference, correctly excluded upstream), neither branch fires and order.trackingNumbers is left unset -- order 930 (Walmart #200015142733782, page shows 'Deliver via Walmart: 55584564635296042425') synced with an empty trackingNumbers array.

## Entry point

sidecar/src/walmart.js:442

## Required change

Whenever detail.tracking.length === 0 (no real carrier tracking found), regardless of isStoreDelivery, order.trackingNumbers must be set to [order.orderNumber.replace(/[^0-9]/g, '')] -- the order number with any non-digit characters (e.g. a hyphen) stripped.

Behaviour that must NOT change:
- When detail.tracking has at least one real number, order.trackingNumbers must still be set from
  detail.tracking (filtered to exclude any value equal to order.orderNumber), exactly as before --
  the fallback must NEVER override or append to a real detected tracking number.
- A store-delivery order (detail.isStoreDelivery === true) with no real tracking must still end up
  with order.trackingNumbers containing the order number, same as before -- this case is now
  covered by the broadened detail.tracking.length === 0 condition rather than its own branch, but
  the outcome for that order must be identical.
- Every other field the per-order loop sets (shippingAddress, cost, itemDescription,
  paymentLast4, deliveryPhotoUrl/Base64/Mime, orderDate) must be untouched.

## Must contain

- `replace(/[^0-9]/g`

(The gate holds the reference impl against this list. If the verify goes green
while one of these is absent from the changed files, the verify does not
enforce the spec -- that is a benign verify, caught mechanically.)

(A bare bullet checks the default target. To PIN a literal to a specific file --
useful when a fix spans a helper file and the route/wiring that calls it --
prefix the bullet with `in <path>:`, e.g.
`- in app/api/x/route.ts: ` followed by a backtick-quoted token. Then that
token is required in THAT file, not the target.)

## Scope

Only edit `sidecar/src/walmart.js`; do not edit `verify.sh`, `verify.test.ts` or `TASK.md`.
verify.test.ts is the test fixture -- changing it invalidates the check.

## Test environment

`verify.sh` exports dummy values for these env vars because the target (or a
same-repo dependency) throws at IMPORT time when they are unset. They exist so
the module can LOAD for the behavioural test -- they are placeholders, NOT real
config. Do NOT add code that depends on their values:

- `TRACKER_URL` -- required at import time; dummy `http://localhost:3000`
- `TRACKER_USER_ID` -- required at import time; dummy `1`

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
