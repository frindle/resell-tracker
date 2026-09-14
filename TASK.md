# TASK: rt-address-normalize

## Confirmed defect (observed, not suspected)

confirmed missing capability: the app has no structured saved-address store or importer. Addresses today are only free-text Order.shippingAddress matched to a Buyer(group) by substring ShippingRule.pattern (app/api/orders/apply-rules/route.ts:23, lib/matchBuyerId). Enhancement: import saved addresses from retailer accounts (Amazon first, then Walmart/Costco) so a group can be mapped to a concrete saved-address entry. Need a pure normalizer turning scraped raw address records into deduped, normalized rows before persistence. No such function exists.

## Entry point

lib/retailerAddressImport.ts:1

## Required change

normalizeRetailerAddresses(raw: RawRetailerAddress[]) returns NormalizedAddress[]: trims/collapses whitespace, drops entries with no line1, defaults country to 'US' uppercased, computes a stable dedupeKey and collapses duplicates (OR-ing isDefault), preserves externalId/platform

Create the NEW file `lib/retailerAddressImport.ts`. Export interfaces
RawRetailerAddress and NormalizedAddress and a pure function
normalizeRetailerAddresses(raw: RawRetailerAddress[]): NormalizedAddress[].

RawRetailerAddress: { platform, fullName?, line1?, line2?, city?, state?,
postalCode?, country?, phone?, isDefault?, externalId? } (string fields
nullable/optional).
NormalizedAddress: same fields but line1: string (required), country: string,
isDefault: boolean, plus dedupeKey: string.

Rules the tests enforce:
- Drop any entry whose line1 is empty/whitespace/null (unshippable).
- Trim and collapse internal whitespace on every string field ("  123   Main
  St " -> "123 Main St").
- country defaults to "US" when missing and is uppercased ("us" -> "US").
- dedupeKey is a stable string built from platform + line1 + postalCode +
  fullName (lowercased); entries with the SAME dedupeKey collapse to ONE row,
  and that row's isDefault is the OR of the duplicates' isDefault. A DIFFERENT
  postalCode is NOT a duplicate.
- Preserve platform and externalId. Empty array -> empty array (no throw).
- Pure function: no I/O, no imports beyond the declared types.

## Must contain

- `export function normalizeRetailerAddresses`
- `dedupeKey`
- `isDefault`

(The gate holds the reference impl against this list. If the verify goes green
while one of these is absent from the changed files, the verify does not
enforce the spec -- that is a benign verify, caught mechanically.)

## Scope

Only edit `lib/retailerAddressImport.ts`; do not edit `verify.sh`, `verify.test.ts` or `TASK.md`.
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
