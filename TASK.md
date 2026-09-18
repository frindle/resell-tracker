# TASK: bfmr-sync-reservations-500-guard

## Confirmed defect (observed, not suspected)

Confirmed via git history + source read (no live traceback available: the Unraid GraphQL/MCP integration used for container-log access is currently connection-refused per this session's tool list, there is no SSH to Unraid and no Docker on this Mac, and the deployed app requires a login this session has no credentials for -- so the server-side stack trace could not be pulled directly this session). app/api/bfmr/sync-reservations/route.ts:49 calls 'const filterResults = await Promise.all(filters.map(f => getMyTrackerAll(creds, f)));' with NO try/catch. getMyTrackerAll -> getMyTracker -> bfmrFetch (lib/bfmr.ts:115-127) throws a plain Error on ANY non-OK BFMR response ('BFMR ${res.status}: ${body}', e.g. 401 on an expired/invalid API key) and the fetch call carries a 30s AbortSignal.timeout that also throws on expiry -- both surface here as an UNCAUGHT exception, which Next.js turns into a bare 500 Internal Server Error matching the reported symptom 'Sync from BFMR failed: HTTP 500 Internal Server Error'. This is the exact same class of bug already fixed in the SIBLING route on 2026-09-17 (commit e88f23a, 'fix(bfmr): guard sync-orders 500s from tracker fetch + bad body'), which wrapped its own getMyTrackerAll call in try/catch returning a 502 -- that fix was never applied to sync-reservations, which still has the unguarded call. Whether the underlying BFMR-side trigger is an expired auth key, a BFMR outage, or a block, is undetermined without server logs -- but regardless of trigger, the missing try/catch is a genuine code defect: the handler must never let a BFMR-side failure surface as an uncaught 500.

## Entry point

app/api/bfmr/sync-reservations/route.ts:49

## Required change

Replace ONLY this line (route.ts:49):

```
  const filterResults = await Promise.all(filters.map(f => getMyTrackerAll(creds, f)));
```

with exactly this shape (an IIFE so the try/catch is a self-contained expression, plus the
call-site check right after it):

```
  const filterResults = await (async () => {
    try {
      return await Promise.all(filters.map(f => getMyTrackerAll(creds, f)));
    } catch (e) {
      return { __bfmrError: true, status: 502, message: `BFMR fetch failed: ${String(e)}` };
    }
  })();
  if (filterResults && typeof filterResults === 'object' && '__bfmrError' in filterResults) {
    return Response.json({ error: filterResults.message }, { status: filterResults.status });
  }
```

On success, behavior is unchanged (same array-of-arrays result, same order as `filters`,
`filterResults` still iterable by the existing `for (const items of filterResults)` loop right
below it). On failure (`getMyTrackerAll` rejects for ANY filter -- `Promise.all`'s existing
all-or-nothing semantics must be preserved exactly as shown; do not change to `allSettled` or
per-filter swallowing), the exception is caught and converted to the `__bfmrError` result, then
the guard above returns a 502 `Response.json` carrying the literal text `BFMR fetch failed:`
followed by the original underlying error's own `String(e)` (e.g. an underlying
`BFMR 401: invalid key`, or an AbortError from the 30s timeout, must both be visible in the
surfaced message, never replaced with a generic string) -- never re-thrown, never left to
surface as an uncaught 500. Fix any resulting `tsc` narrowing complaint (e.g. downstream code
that assumes `filterResults` is an array) by keeping the early `return` in the `if` block so
control flow never reaches the loop below with an error object -- do not add an `as any` cast
to silence it.

Behaviour that must NOT change:
- A successful sync (no filter rejects) must reach the existing dedup/upsert/web-backfill/
  auto-link logic below exactly as before, with `filterResults` in the same shape and order.
- The existing `401 not authenticated` (missing session/extension auth) and `400 BFMR API
  credentials not configured` early returns above this line are untouched.
- The `filters` array itself (the single full-status-enum filter) is unchanged -- this task is
  about catching a fetch failure, not about what is fetched.

## Must contain

- `__bfmrError`
- `status: 502`
- `BFMR fetch failed`

(The gate holds the reference impl against this list. If the verify goes green
while one of these is absent from the changed files, the verify does not
enforce the spec -- that is a benign verify, caught mechanically.)

(A bare bullet checks the default target. To PIN a literal to a specific file --
useful when a fix spans a helper file and the route/wiring that calls it --
prefix the bullet with `in <path>:`, e.g.
`- in app/api/x/route.ts: ` followed by a backtick-quoted token. Then that
token is required in THAT file, not the target.)

## Scope

Only edit `app/api/bfmr/sync-reservations/route.ts`; do not edit `verify.sh`, `verify_impl.mjs` or `TASK.md`.
verify_impl.mjs is the test fixture -- changing it invalidates the check.

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
