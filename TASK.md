# TASK: bfmr-overcount

## Confirmed defect (observed, not suspected)

confirmed: splitting a purchased BFMR reservation into per-shipment tracked child OrderBfmrLinks leaves the parent no-tracking link in place (and can create a duplicate re-using another reservation's trackingNumber), so recalcBfmrSalePrice (lib/bfmrSalePrice.ts:127 reduce) sums phantom links and inflates salePrice/bgExpectedPayout. Verified: orders 898/906/907 each had 4 links where 3 were correct; deleting the phantom link (167/168/155) restored the correct salePrice.

## Entry point

lib/bfmrLinkReconcile.ts:27

## Required change

selectCanonicalBfmrLinks(links) returns only canonical links: for each reservationId that has >=1 tracked link (non-null, non-empty trackingNumber), its no-tracking parent link(s) are dropped; a reservation with no tracked link keeps its no-tracking link unchanged (un-split reservations must not be emptied); a non-null trackingNumber appears at most once in the output, keeping the smallest id on collision; other fields preserved on kept links; input never mutated.

Behaviour that must NOT change:
- An un-split reservation's single no-tracking link is returned UNCHANGED
  (dropping it would zero out a legitimate order -- over-trigger guard).
- A legitimately multi-shipment reservation (parent already gone, N distinct
  tracked children) is returned intact -- every tracked child kept.
- Links for one reservation are never affected by another reservation's links,
  except the cross-reservation duplicate-trackingNumber dedup.
- Non-`id`/`reservationId`/`trackingNumber` fields (value, quantity, ...) are
  preserved on every kept link; the input array and its objects are not mutated.

## Must contain

- `trackingNumber`
- `reservationId`
- `selectCanonicalBfmrLinks`

(The gate holds the reference impl against this list. If the verify goes green
while one of these is absent from the changed files, the verify does not
enforce the spec -- that is a benign verify, caught mechanically.)

(A bare bullet checks the default target. To PIN a literal to a specific file --
useful when a fix spans a helper file and the route/wiring that calls it --
prefix the bullet with `in <path>:`, e.g.
`- in app/api/x/route.ts: ` followed by a backtick-quoted token. Then that
token is required in THAT file, not the target.)

## Scope

Only edit `lib/bfmrLinkReconcile.ts`; do not edit `verify.sh`, `verify.test.ts` or `TASK.md`.
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
