# TASK: rt-costco-always-sites-s1-loginqueue-js-near-lines-s1-in-sidecar-src-loginqueu

## Confirmed defect (observed, not suspected)

Costco is treated as an OPT-IN site by the login-queue daemon. Observed in
`sidecar/src/loginQueue.js` lines 28-29: `ALWAYS_SITES = ['amazon', 'walmart']`
and `OPT_IN_SITES = { costco: 'costco_sidecar_enabled' }`. Consequence, traced
through `activeSites()` and `sitesNeedingLogin()`: when the
`costco_sidecar_enabled` Setting is unset (the default), a Costco account with
no valid session is never queued for the shared VNC login window -- its expired
session sits unattended while amazon/walmart get their windows. The intent of
the daemon's own header comment ("keeps a real Chrome window open on ... that
site's login page") applies to all tracked sites, so Costco must be always-on
like the other two.

## Entry point

sidecar/src/loginQueue.js:28 (the `ALWAYS_SITES` / `OPT_IN_SITES` declarations)

## Required change

Make Costco an always-queued site, exactly like amazon and walmart:

1. `ALWAYS_SITES` must list all three sites in this order:
   `['amazon', 'walmart', 'costco']`.
2. Costco must no longer depend on the `costco_sidecar_enabled` Setting. Clear
   it out of `OPT_IN_SITES` (e.g. `const OPT_IN_SITES = {};`) so that a site is
   never queued twice when the legacy flag happens to be set -- `activeSites()`
   concatenates both lists, so leaving costco in BOTH would duplicate it.

Do not restructure anything else: `activeSites()`, `isEnabled()`, and
`sitesNeedingLogin()` keep their current logic; only the two site-list
declarations change.

Behaviour that must NOT change (the verify pins these):
- amazon and walmart remain always queued, in that order, with costco last.
- A site with a valid session file AND a non-expired tracker status is NOT queued.
- A site whose tracker status is `expired` IS queued even if a session file exists.
- If `getSettings()` throws, the queue falls back to the local session-file check only (no crash).
- The module still exports `{ sitesNeedingLogin, runQueueOnce }`, and
  `sitesNeedingLogin()` never launches a browser.

## Must contain

- `const ALWAYS_SITES = ['amazon', 'walmart', 'costco'];`
- `module.exports = { sitesNeedingLogin, runQueueOnce };`

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
