# TASK: bfmr-cap-link-to-reservation

## Confirmed defect (observed, not suspected)

confirmed: order 768 link 97 qty2/value598 over-allocated reservation 6481 (qty1/payout299); recalcBfmrSalePrice summed the stale snapshot so bgExpectedPayout=897 vs correct 598. Root cause: candidate query at bfmrAutoLink.ts:26 filters orderLinks:{none:{}}, excluding already-linked reservations from the shrink logic, so an existing link is never reduced when BFMR splits its reservation smaller.

## Entry point

lib/bfmrAutoLink.ts:26

## Required change

Add a PURE, EXPORTED helper to `lib/bfmrAutoLink.ts` and wire it into `autoLinkBfmrReservations`.

Exact signature the test imports (`import { capLinkToReservation } from '@/lib/bfmrAutoLink'`):

```ts
export function capLinkToReservation(
  link: { quantity: number; value: number | null },
  reservation: { qty: number; totalPayout: number | null },
): { quantity: number; value: number | null } | null
```

Rules:
- `cappedQty = Math.min(link.quantity, reservation.qty)`.
- `expected = expectedLinkValue(reservation.totalPayout, reservation.qty, cappedQty)` (import it from `@/lib/bfmrLinkValue`; it returns null when totalPayout is null).
- The link OVER-ALLOCATES when `link.quantity > reservation.qty` OR (`link.value != null` and `expected != null` and `link.value` exceeds `expected` beyond a ~0.005 rounding tolerance).
- If it does NOT over-allocate, return `null` (no change) — never raise an under-allocated value up to the share.
- If it does, return `{ quantity: cappedQty, value }` where `value` = `expected` when the link value is null, `Math.min(link.value, expected)` when both are present, and the untouched `link.value` when `expected` is null (totalPayout null — cap qty only, never throw).

WIRING (reviewed by hand, not by the pure verify): after the reservation upserts in `autoLinkBfmrReservations`, add a second pass over reservations that ALREADY have links (the `orderLinks: { none: {} }` filter at line 26 excludes them from the existing shrink logic — that exclusion is the root cause). For each such link, call `capLinkToReservation`; when it returns non-null, `prisma.orderBfmrLink.update` the link to the capped quantity/value, then `recalcBfmrSalePrice` the affected order so salePrice AND bgExpectedPayout both drop.

Behaviour that must NOT change:
- A correctly-allocated link (quantity == reservation.qty AND value == its share) returns `null` — unchanged.
- An under-allocated / hand-lowered link (value below the share) returns `null` and is NEVER inflated up to the share.
- `capLinkToReservation` must NOT throw on a null `value` or a null `totalPayout`.
- The existing behaviour for reservations with NO links (the current first pass) is unchanged — the new second pass is additive.

## Must contain

- `capLinkToReservation`
- `expectedLinkValue`
- `Math.min`

(The gate holds the reference impl against this list. If the verify goes green
while one of these is absent from the changed files, the verify does not
enforce the spec -- that is a benign verify, caught mechanically.)

(A bare bullet checks the default target. To PIN a literal to a specific file --
useful when a fix spans a helper file and the route/wiring that calls it --
prefix the bullet with `in <path>:`, e.g.
`- in app/api/x/route.ts: ` followed by a backtick-quoted token. Then that
token is required in THAT file, not the target.)

## Scope

Only edit `lib/bfmrAutoLink.ts`; do not edit `verify.sh`, `verify.test.ts` or `TASK.md`.
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
