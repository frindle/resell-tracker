# TASK: rt-dashboard-pl-unsubmitted-cc

## Confirmed defect (observed, not suspected)

The dashboard home page (`app/page.tsx`) computes its "This Month", "This
Quarter" and "Year to Date" P&L cards from three `prisma.order.findMany` calls
that filter only on `cancelled: false, ignoredByRule: false` plus the date
range. Card Center orders whose gift cards are ALL unsubmitted (every card has
`ccSubmittedAt = null`) therefore still count in those totals, while
`app/api/analytics/route.ts` already excludes exactly that set via its
`unsubmittedCCFilter`. Verified by reading both files: the analytics route's
where-clause is `{ ...userFilter, ...unsubmittedCCFilter, orderDate: {...} }`,
and none of `app/page.tsx`'s three period queries reference `giftCards` or any
equivalent clause at all — so for a user with unsubmitted-CC orders in the
period, "This Month" on `/` and "Current Month" on `/analytics` sum different
order sets.

## Entry point

app/page.tsx:27 (the three period `findMany` calls inside the `Promise.all`,
lines 28–30)

## Required change

Dashboard home-page P&L totals (month/quarter/YTD queries in app/page.tsx) must
exclude Card Center orders whose gift cards are all unsubmitted, the same way
app/api/analytics/route.ts already does via its `unsubmittedCCFilter`.

Concretely:
- Define the exact same where-clause object as
  `app/api/analytics/route.ts` — `{ NOT: { AND: [{ giftCards: { some: {} } }, { giftCards: { every: { ccSubmittedAt: null } } }] } }`
  (NOT a bare `{ AND: [...] }` without the outer `NOT`; that would INVERT the
  filter and drop every non-CC order).
- Spread it into each of the three period findMany where-clauses, alongside the
  existing `cancelled: false, ignoredByRule: false` conditions (e.g.
  `{ ...userFilter, cancelled: false, ignoredByRule: false, ...unsubmittedCCFilter, orderDate: {...} }`).

Behaviour that must NOT change:
- A partially-submitted CC order (at least one card with `ccSubmittedAt` set)
  still counts in the P&L totals.
- Non-Card-Center orders (no gift cards at all) are unaffected — the
  `giftCards: { some: {} }` guard must stay, or every plain order is dropped by
  the vacuous `every`.
- The all-time query (`calls[0]`, no date range, includes buyer/card/returns)
  keeps its exact existing where-shape `{ ...userFilter }` — it gains neither
  the CC filter nor a `cancelled: false`.
- All other dashboard behaviour (recent orders table, outstanding-by-group,
  needs-attention chips, all-time stats) is untouched.

## Must contain

- `unsubmittedCCFilter`
- `{ NOT: { AND: [{ giftCards: { some: {} } }, { giftCards: { every: { ccSubmittedAt: null } } }] } }`
- `...unsubmittedCCFilter, orderDate:`

(The gate holds the reference impl against this list. If the verify goes green
while one of these is absent from the changed files, the verify does not
enforce the spec -- that is a benign verify, caught mechanically.)

## Scope

Only edit `app/page.tsx`; do not edit `verify.sh`, `verify.test.ts` or `TASK.md`.
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
