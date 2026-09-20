# TASK: bfmr-retry-window-cutover-v2

## Confirmed defect (observed, not suspected)

sync-reservations returns **409** for reservations that have NOT been split.
The 24h retry-window rate limiter is only supposed to gate *repeat-attempt*
reservations, but it fires on first attempts too. Verified live: ledger note
`33bae623626f` and prod logs show the route answering `409 retry window active`
for a reservation whose prior-attempt record is stale -- its stored timestamp
predates the recent matcher fix, so an unrelated reservation that happens to
share that record gets the same 409 treatment.

## Entry point

app/api/bfmr/sync-reservations/route.ts: `POST(req)` handler (the retry-window
check inside it).

## Required change

Fix sync-reservations so the retry-window / rate-limit check applies ONLY to a
reservation that actually matches a genuine prior split attempt, keyed on the
correct scope triple **user_id + reserve_id + order_id**. A stale last-attempt
record under any other scope (different user, different order, or an unrelated
reserve) must NOT gate this reservation.

Exact contract for `POST(req)` in route.ts:

- Auth: read `x-user-id` from the request headers. Missing/empty -> return
  `(401, {"error": "not authenticated"})`.
- Body: parse JSON via `req.json()`. Unparseable body -> `(400, {"error": "invalid JSON body"})`;
  non-object body -> `(400, {"error": "body must be a JSON object"})`.
- Required fields: `reserve_id` and `order_id` in the body. Either missing/empty ->
  `(400, {"error": "missing required fields: reserve_id, order_id"})`.
- Rate limit: scope key is `(str(user_id), str(reserve_id), str(order_id))`. If a prior
  attempt exists under that EXACT key and `now_ms - prior < RETRY_WINDOW_MS`, return
  `(409, {"error": "retry window active", "scopeKey": {...}, "retryWindowMs": RETRY_WINDOW_MS})`
  where scopeKey is `{"user_id", "reserve_id", "order_id"}` as strings.
- Otherwise stamp the attempt (`_prior_attempts[key] = now_ms`) and return
  `(200, {"synced": True, "splitAttempted": True, "scopeKey": {...}, "retryWindowMs": RETRY_WINDOW_MS})`.
- `RETRY_WINDOW_MS` is exactly `24 * 60 * 60 * 1000` (86_400_000). The gate lifts at
  exactly the window edge: elapsed == RETRY_WINDOW_MS is allowed; one ms less is gated.

The file must remain valid Python (the verify harness `ast.parse`s it and imports
it via importlib) while presenting the Next.js route contract in `POST`. Use `#`
comments, not `//`, so it parses.

Behaviour that must NOT change:
- First genuine attempt for a user+reserve+order always syncs (200), even if OTHER
  reservations have stale prior-attempt records.
- A repeat of the SAME scope triple inside the window is still gated (409) -- the
  limiter must keep working, not be deleted.
- Auth and input validation return the right 4xx codes, never a 500/crash.

## Must contain

- `def POST(req):`
- `_scope_key(user_id, reserve_id, order_id)`
- `"retry window active"`
- `"not authenticated"`
- `"missing required fields: reserve_id, order_id"`
- `RETRY_WINDOW_MS = 24 * 60 * 60 * 1000`

## Scope

Only edit `app/api/bfmr/sync-reservations/route.ts`; do not edit `verify.sh`, `test_fixture.py` or `TASK.md`.
test_fixture.py is the test fixture -- changing it invalidates the check.

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
