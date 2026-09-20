# TASK: rt-costco-always-sites-s2-costco-to-always-sites

## Confirmed defect (observed, not suspected)

`sidecar/src/loginQueue.js` keeps Costco out of the always-on login queue by
default. Reproduced directly against the module: with `TRACKER_URL` and
`TRACKER_USER_ID` set so it loads, `activeSites({})` returns only
`['amazon', 'walmart']`, and even an explicit
`{ costco_sidecar_enabled: 'true' }` is moot in practice because Costco sits
behind the `OPT_IN_SITES` gate (`costco_sidecar_enabled` Setting) that nothing
in the app can turn on. So a dead Costco session never gets its login window
opened by the queue, while amazon/walmart always do.

## Entry point

sidecar/src/loginQueue.js:27 (the `ALWAYS_SITES = ['amazon', 'walmart']` /
`OPT_IN_SITES = { costco: 'costco_sidecar_enabled' }` pair and the
`activeSites(statuses)` function built on it).

## Required change

In sidecar/src/loginQueue.js: add 'costco' to the ALWAYS_SITES array so the login queue always opens the Costco login, instead of it being gated behind the OPT_IN_SITES costco_sidecar_enabled setting that nothing can turn on. activeSites(statuses) must therefore return costco even when statuses is empty / has no costco_sidecar_enabled key. Export activeSites (and isEnabled) from the module so the behaviour can be tested directly.

Behaviour that must NOT change:
- `activeSites({})` still returns amazon and walmart, in their original order, with costco appended after them — exactly `['amazon', 'walmart', 'costco']`.
- No site appears twice; sites missing from `SITE_CONFIG` are still filtered out.
- `isEnabled(value)` keeps its exact truthy-spelling contract: true for `'1'`, `'true'`, `'yes'`, `'on'` (case-insensitive, trimmed), false for everything else including `undefined`/`null`/`''` — and never throws on degenerate input.
- `sitesNeedingLogin` / `runQueueOnce` keep their existing exports and behaviour; the module still only runs `main()` when executed directly (`require.main === module`).

## Must contain

- `['amazon', 'walmart', 'costco']`
- `activeSites`
- `isEnabled`
- `module.exports = { sitesNeedingLogin, runQueueOnce, activeSites, isEnabled };`

(The gate holds the reference impl against this list. If the verify goes green
while one of these is absent from the changed files, the verify does not
enforce the spec -- that is a benign verify, caught mechanically.)

## Scope

Only edit `sidecar/src/loginQueue.js`; do not edit `verify.sh`, `verify.test.ts` or `TASK.md`.
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
