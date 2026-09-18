# TASK: rt-pl-exclude-unsubmitted-cc

## Confirmed defect (observed, not suspected)

Order 926 is a Card Center order whose gift cards were never submitted to the
Card Center — every `GiftCard.ccSubmittedAt` on it is null. Its purchase cost
is still being summed into P&L in `app/api/analytics/route.ts`, so "This Month"
(and quarter/YTD, which share the same query) show a loss for goods that were
never actually bought. Verified by reading the route: every `prisma.order.findMany`
builds its `where` from only `{ userId, ignoredByRule: false, cancelled: false }`
plus an `orderDate` range — nothing looks at the order's gift cards or their
submission state, so all-unsubmitted Card Center orders flow straight into
`calcStats`.

## Entry point

app/api/analytics/route.ts:21 (the `userFilter` line; the three query sites are
the two period `findMany`s near lines 30-31 and the monthly-rows `findMany`
near line 45)

## Required change

Exclude Card Center orders whose gift cards are ALL unsubmitted — meaning every
gift card on the order has `ccSubmittedAt: null` — from the P&L calculation in
BOTH calc sites (the period queries and the monthly-chart query), so order 926
stops dragging the month P&L. Do NOT exclude non-Card-Center pending orders,
whose cost is real: those orders have no submitted Card Center gift cards either,
but their purchase actually happened, so they must stay in every total.

Concretely:
1. The `SELECT` object (near lines 9-12) must also fetch the `giftCards`
   relation (`giftCards: true`) so the relation filter has its data.
2. Add a shared Prisma NOT-clause named `unsubmittedCCFilter` that excludes
   orders which BOTH have at least one gift card AND have every gift card
   unsubmitted, and spread it into EVERY `findMany` where in this route (the
   current-period query, the prior-year comparison query, and the monthly-rows
   query) alongside the existing `{ userId, ignoredByRule: false, cancelled: false }`.

   Get the Prisma relation semantics exactly right — both halves matter:
   - `every` over an EMPTY relation is vacuously TRUE in Prisma (it compiles to
     `NOT EXISTS (… WHERE NOT <cond>)`). So a bare
     `NOT: { giftCards: { every: … } }` also drops every order that has no gift
     cards at all — i.e. all non-Card-Center orders. Guard it with
     `giftCards: { some: {} }` so the exclusion only applies to orders that
     actually have gift cards.
   - The inner condition must test for UNSUBMITTED (`ccSubmittedAt: null`), not
     submitted. `every: { ccSubmittedAt: { not: null } }` is the opposite
     property (all cards SUBMITTED) and under the `NOT` it keeps order 926 and
     drops the healthy ones.

   The shape that satisfies both:
   `const unsubmittedCCFilter = { NOT: { AND: [{ giftCards: { some: {} } }, { giftCards: { every: { ccSubmittedAt: null } } }] } };`

Behaviour that must NOT change:
- Cancelled and `ignoredByRule` orders are still excluded exactly as before.
- Card Center orders with at least one submitted gift card (any
  `ccSubmittedAt` non-null) stay in the P&L — including PARTIALLY submitted
  orders (some cards submitted, some not). Only an order whose gift cards are
  ALL unsubmitted is excluded; a filter keyed on "every card submitted" gets
  this backwards and drops the partial ones.
- Non-Card-Center pending orders (no submitted gift cards, real cost) stay in
  the P&L — this is the over-trigger trap; a filter that drops them is wrong.
- Unauthenticated requests still work: when there is no session user the filter
  uses `userId: null` and the route still returns 200 with `{ periods, monthly }`.
- A prisma failure still surfaces as HTTP 500 with body `{ error: <string> }`,
  never an unhandled crash.
- The response shape is unchanged: `{ periods: [...], monthly: [...] }` where
  each period has `current`/`comparison` stats and the monthly rows carry
  `revenue/cost/cashback/profit/miles/count`.

## Must contain

- `giftCards: true`
- `giftCards: { some: {} }`
- `every: { ccSubmittedAt: null }`
- `...unsubmittedCCFilter`
- `export async function GET()`

(The gate holds the reference impl against this list. If the verify goes green
while one of these is absent from the changed files, the verify does not
enforce the spec -- that is a benign verify, caught mechanically.)

## Scope

Only edit `app/api/analytics/route.ts`; do not edit `verify.sh`, `verify.test.ts` or `TASK.md`.
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
