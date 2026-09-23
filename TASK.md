# TASK: rt-bfmr-pending-sync-scope-s2-export-function-parsebfm

## Confirmed defect (observed, not suspected)

`lib/bfmrSyncScope.ts` currently contains only a placeholder stub
(`export {};`) — there is no `BfmrSyncScope` type and no
`parseBfmrSyncScope` function anywhere in the repo. Callers that need to
coerce an untrusted raw sync-scope value (query string / localStorage) into a
valid scope have nothing to import; verified by grepping `lib/`, `app/` and
`components/` for `parseBfmrSyncScope` / `BfmrSyncScope` — zero hits outside
the stub.

## Entry point

lib/bfmrSyncScope.ts:1 (the whole file is the stub; add the export here)

## Required change

In lib/bfmrSyncScope.ts, define and export a sync-scope type plus a parser:

- `export type BfmrSyncScope = 'all' | 'pending';`
- `export function parseBfmrSyncScope(raw: unknown): BfmrSyncScope`

Exact contract for `parseBfmrSyncScope`:

1. If `raw === 'all'`, return `'all'`. If `raw === 'pending'`, return
   `'pending'`. (Strict, case-sensitive equality — no trimming.)
2. For every other input — `undefined`, `null`, numbers, booleans, objects,
   arrays, symbols, empty or whitespace strings, and any non-canonical string
   such as `'ALL'`, `'Pending'`, `' pending'` — return the default `'all'`.
3. It must NEVER throw: it runs on untrusted input at module boundaries.

Behaviour that must NOT change:
- The file stays a pure, dependency-free module (no imports of app code).
- No other exports or behaviour are added beyond what is listed above; the
  two canonical values `'all'` and `'pending'` keep their exact spelling.

## Must contain

- `export type BfmrSyncScope = 'all' | 'pending';`
- `export function parseBfmrSyncScope(raw: unknown): BfmrSyncScope {`
- `return DEFAULT_BFMR_SYNC_SCOPE;`

(The gate holds the reference impl against this list. If the verify goes green
while one of these is absent from the changed files, the verify does not
enforce the spec -- that is a benign verify, caught mechanically.)

(A bare bullet checks the default target. To PIN a literal to a specific file --
useful when a fix spans a helper file and the route/wiring that calls it --
prefix the bullet with `in <path>:`, e.g.
`- in app/api/x/route.ts: ` followed by a backtick-quoted token. Then that
token is required in THAT file, not the target.)

## Scope

Only edit `lib/bfmrSyncScope.ts`; do not edit `verify.sh`, `verify.test.ts` or `TASK.md`.
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
