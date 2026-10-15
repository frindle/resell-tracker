# TASK: resell-sync-queue-when-busy

## Confirmed defect (observed, not suspected)

DEFECT: When `acquireBrowserLock` returns a `BrowserBusyError` with `e.holder.kind === 'sync'` (another sync is running), `handleCommand` in `sidecar/src/poll.js` (lines 248-251) immediately fails the command with `-- try again when the login window is closed`, which is the wrong error message and wastes the queued command. At baseline, a sync-busy error is treated identically to a login-busy error, both failing the command with a login-window-blaming message.

## Entry point

`sidecar/src/poll.js:230` -- `handleCommand` function, the `acquireBrowserLock` call and its `BrowserBusyError` catch block (lines 230-252).

## Required change

Observed symptom: with an Amazon order sync running in the sidecar, a Walmart sync command is marked FAILED after the 60s lock wait with 'sync in progress (amazon) -- try again when the login window is closed' (handleCommand in sidecar/src/poll.js, BrowserBusyError from acquireBrowserLock). Wanted: when the browser lock is busy because ANOTHER SYNC is running (not an interactive login window), the command must stay queued and run automatically after the running sync finishes, instead of failing; bounded so it cannot wait forever (max total wait and a clear failure message if exceeded), commands run one at a time in claim order, and no command is lost or double-run. When the lock is busy because of an interactive login window, keep today's failure behaviour and message. The failure message for the sync-busy case must no longer blame the login window.

Behaviour that must NOT change:
- When `e.holder.kind === 'login'`, the existing preempt logic (requestPreempt, LOGIN_PREEMPT_WAIT_MS, clearPreemptRequest) and the login-window-blaming failure message remain exactly as-is.
- Commands with no saved session (`!hasSession(site)`) still fail immediately with the no-session message.
- Sessionless commands (`cfg.kind === 'sessionless'`) continue to use the existing `handleSessionlessCommand` path unchanged.
- The `inFlight` Set deduplication in `pollOnce()` remains unchanged.
- `SITES` map, `BACKFILL_TARGET_TYPE`, and all sync functions (syncAmazon, syncWalmart, etc.) are untouched.

## Must contain

- `BrowserBusyError`
- `acquireBrowserLock`
- `e.holder.kind === 'sync'`
- `e.holder.kind === 'login'`
- `loginCooldown.requestPreempt`
- `loginCooldown.clearPreemptRequest`
- `LOGIN_PREEMPT_WAIT_MS`
- `SYNC_LOCK_WAIT_MS`
- `patchCommand(cmd.id, 'failed', { error:`
- `-- try again when the login window is closed`
- `-- try again when the sync finishes`
- `inFlight`

## Scope

Only edit `sidecar/src/poll.js`; do not edit `verify.sh`, `verify.test.ts` or `TASK.md`.
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
