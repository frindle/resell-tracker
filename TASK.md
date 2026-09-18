# TASK: rt-costco-always-sites-s1-loginqueue-js-near-lines

## Confirmed defect (observed, not suspected)

TODO -- state the CONFIRMED defect: the observed symptom and how you
verified it. Not a suspected mechanism, not a named culprit. If you
have not actually reproduced it, stop and reproduce it first: a task
asserting a defect that does not exist still gets you a change.

## Entry point

TODO -- sidecar/src/loginQueue.js:<line>

## Required change

In sidecar/src/loginQueue.js: loginQueue.js near lines 28-29 ALWAYS_SITES lists amazon and walmart and OPT_IN_SITES maps costco to costco_sidecar_enabled.

Behaviour that must NOT change:
- TODO -- list what must still hold. This is where regressions get caught: the
  verify's non-adversarial half exists to pin these, and a fix that breaks one
  should turn them red.

## Must contain

- `TODO -- a literal token the correct change necessarily introduces`

(The gate holds the reference impl against this list. If the verify goes green
while one of these is absent from the changed files, the verify does not
enforce the spec -- that is a benign verify, caught mechanically.)

(A bare bullet checks the default target. To PIN a literal to a specific file --
useful when a fix spans a helper file and the route/wiring that calls it --
prefix the bullet with `in <path>:`, e.g.
`- in app/api/x/route.ts: ` followed by a backtick-quoted token. Then that
token is required in THAT file, not the target.)

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
