# TASK: rt-group-address-match

## Confirmed defect (observed, not suspected)

confirmed missing capability: when an order moves to a new group, it still ships to the OLD group's address (locked on Amazon at order time). amazon.js:157 captures the free-text shippingAddress ('Ship to ... United States') on pending orders, but nothing re-validates it against the NEW group's expected saved address after a move. No comparator exists (grep addressMatch/checkGroupAddress -> none).

## Entry point

lib/groupAddressMatch.ts:1

## Required change

checkGroupAddressMatch(orderShippingAddress, expected, opts) returns {matches, changeable, reason}: normalizes both addresses (case/whitespace-insensitive, compares street line1 + postalCode), matches true only when line1 and postalCode both agree; changeable true only when opts.shipped is false (unshipped orders can still have the Amazon address changed); never mutates anything, only flags

Create the NEW file `lib/groupAddressMatch.ts`. Export interfaces
ExpectedAddress { line1: string; postalCode: string|null } and
AddressMatchResult { matches: boolean; changeable: boolean; reason: string },
and a pure function
checkGroupAddressMatch(orderShippingAddress: string|null, expected, opts: {shipped: boolean}): AddressMatchResult.

Rules the tests enforce:
- Normalize both sides case- and whitespace-insensitively (strip punctuation).
- matches = expected.line1 (normalized) appears in the normalized order address
  AND, when expected.postalCode is non-null, its digits appear in the order
  address. BOTH must hold: line1-only or zip-only is NOT a match.
- When expected.postalCode is null, match on line1 alone.
- changeable = !opts.shipped (an unshipped order can still have its Amazon
  address changed; a shipped one cannot) -- independent of whether it matches.
- null/empty orderShippingAddress -> matches false, a non-empty reason, no throw.
- NEVER mutate anything; only return flags + a human-readable reason.
- Pure function: no I/O, no imports beyond the declared types.

## Must contain

- `export function checkGroupAddressMatch`
- `changeable`
- `matches`

(The gate holds the reference impl against this list. If the verify goes green
while one of these is absent from the changed files, the verify does not
enforce the spec -- that is a benign verify, caught mechanically.)

## Scope

Only edit `lib/groupAddressMatch.ts`; do not edit `verify.sh`, `verify.test.ts` or `TASK.md`.
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
