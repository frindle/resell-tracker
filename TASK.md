# TASK: bfmr-retry-window-cutover-bonsai

## Confirmed defect (observed, not suspected)

Confirmed live: `sync-reservations` returns HTTP 409 for reservations that have
NOT been split. The split-order retry-window rate limiter is only supposed to gate
repeat-attempt reservations (a genuine prior split attempt within the last 24h),
but it keys on a stored last-attempt timestamp WITHOUT scoping to the reservation's
own identity, so a reservation that was never actually split matched a stale/incorrect
prior-attempt record and got the same 409 treatment. Verified via live-validation-ledger
note 33bae623626f and prod logs: unsplit reservations were being 409'd while
genuinely-retried splits were also 409'd, indistinguishable from correct behaviour
except by the reservation's split state.

## Entry point

`app/api/bfmr/sync-reservations/route.ts` -- the route module that implements the
retry-window rate-limit contract (the `sync_reservations` decision function and its
helpers). The whole module is replaced with a pure, I/O-free decision module.

## Required change

Fix sync-reservations so the 24h retry-window / rate-limit check applies ONLY to
reservations that actually match a GENUINE prior split attempt under the correct
key/scope, not to unrelated reservations that happen to share a stale timestamp
record.

The corrected route module must expose this exact contract (pure decision logic,
no I/O, no network, no DB):

- `RETRY_WINDOW_MS` -- the 24-hour retry window in milliseconds.
- `split_attempt_key(reservation)` -- returns the key for a GENUINE prior split
  attempt, scoped on the reservation's own identity: `user_id`, `reserve_id`, AND
  `order_id`. Keying on user alone (or user+reserve only) is wrong and must be
  avoided.
- `sync_reservations(reservation, attempts_by_key, now_ms)` -- returns a dict
  `{"status": int, "reason": str}`:
  - `409` / `"retry_window"` ONLY when there is a genuine prior split attempt for
    this exact reservation (same key) whose timestamp is strictly inside the 24h
    window (`0 <= now_ms - last_attempt_at < RETRY_WINDOW_MS`).
  - `200` / `"synced"` otherwise, including when no prior attempt exists, the
    window has elapsed, or inputs are degenerate (missing fields, None).

Degenerate inputs (missing keys, None values, wrong types) must NOT raise.

Behaviour that must NOT change:
- A genuine repeat split attempt within 24h is still gated with 409.
- A reservation retried after the window elapses is allowed (200).
- Degenerate inputs never raise and are not gated.

## Must contain

- `RETRY_WINDOW_MS`
- `split_attempt_key`
- `sync_reservations`
- `"retry_window"`
- `"synced"`
- `user_id`
- `reserve_id`
- `order_id`

## Scope

Only edit `app/api/bfmr/sync-reservations/route.ts`; do not edit `verify.sh`, `test_fixture.py` or `TASK.md`.
test_fixture.py is the test fixture -- changing it invalidates the check.

## Notes on literals (for the author)

A bare bullet in "Must contain" checks the default target file. To PIN a literal
to a specific file, prefix the bullet with `in <path>:` followed by a backtick-quoted
token; that token is then required in THAT file, not the target.

## Keep every changed line exercised (relevance)

After the job runs, a mutation check flips/deletes each line you changed and asks
the verify to catch it. A changed line whose every mutant survives -- because no
test asserts it -- FAILS the gate even when the fix is correct. So do NOT emit an
isolated, untested line:
- Fold an unavoidable constant onto a line the test already exercises. Put a
  `timeout=` / a `daemon=True` flag / a small tuning number on the SAME line as a
  header dict, URL, or argument the fixture checks -- never on its own line.
- Prefer falling through to an implicit `return None` over a standalone
  `return None` in an `except:` the tests do not assert.
- If a line genuinely cannot be asserted and cannot be folded, it usually should
  not be a separate line at all -- restructure so it isn't.

## Loop instruction

Run `bash verify.sh` after every edit and keep editing until it prints `VERIFY_OK`.
