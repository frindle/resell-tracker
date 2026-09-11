# TASK: amazon-iris-payment-fix

## Confirmed defect (observed, not suspected)

confirmed (diagnosis 03cca583f6c1): Amazon payment now renders in a cross-origin iris.apx.amazon.dev iframe; the scraper reads only the main document (amazon.js:340-342, inside page.evaluate at L508) so paymentLast4=undefined and orders import with cardId=null (order 917, Visa 3069).

## Entry point

sidecar/src/amazon.js:509

## Required change

Add a pure exported extractIrisLastDigits(rawText) returning the card last-4 (4-digit string) or null; parse __NEXT_DATA__ paymentMethodNumber.lastDigits first, then bullet/asterisk masking; ignore decoy 4-digit numbers (expiry year, order id). Add ONLY the pure exported helper `extractIrisLastDigits` to
`sidecar/src/amazon.js` (define it near the other module-level functions and add
it to the `module.exports` object). Do NOT wire it into `fetchOrderDetails` --
the Puppeteer `page.frames()` traversal that feeds it is browser-context
integration that is validated on a live Amazon page, not by this fixture, and is
applied separately by hand. Your entire job is the pure parser + its export.

CONTRACT for `extractIrisLastDigits(rawText)`:
- Try structured first: a regex for `"paymentMethodNumber": { ... "lastDigits": "NNNN" }`
  (4 digits) — return those digits.
- Else try masked visible text, in order: `••••`/`·`/`●` (2+), then `**` (2+),
  then `xxxx`, then `ending in`, each followed by 4 digits — return them.
- Else return null. Guard non-string/empty up front. Never throw.

Note: the `page.frames()` traversal itself is validated on a LIVE Amazon sync
(frame discovery cannot be unit-tested); `bash verify.sh` gates the PARSE helper
behaviourally + the wiring literals structurally.

Behaviour that must NOT change:
- `extractIrisLastDigits` MUST be pure and MUST NEVER throw on any input
  (null / undefined / non-string / malformed JSON all return null).
- It must key on the card's `lastDigits` / a masked tail, NEVER return a decoy
  4-digit run (expiry year, order id, amount).
- Do not change any existing exported function, the existing regex extraction at
  amazon.js:340-352, or the returned object shape (paymentLast4 still flows out
  at the `return {` in fetchOrderDetails).

## Must contain

- `extractIrisLastDigits`
- `paymentMethodNumber`
- `lastDigits`

(The gate holds the reference impl against this list. If the verify goes green
while one of these is absent from the changed files, the verify does not
enforce the spec -- that is a benign verify, caught mechanically.)

## Scope

Only edit `sidecar/src/amazon.js`; do not edit `verify.sh`, `verify.test.ts` or `TASK.md`.
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


## Test environment (set by verify.sh -- do not hardcode)

`verify.sh` exports dummy `TRACKER_URL` and `TRACKER_USER_ID` before running the
tests, because importing `sidecar/src/amazon.js` transitively loads
`sidecar/src/lib.js`, which throws at import time when either is unset. These are
never used by the parser under test (it makes no network call); they only let the
module load. Do not read or depend on them in your change.

## Loop instruction

Run `bash verify.sh` after every edit and keep editing until it prints
`VERIFY_OK`.
