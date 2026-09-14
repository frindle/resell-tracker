# TASK: rt-autobuy-decision

## Confirmed defect (observed, not suspected)

confirmed missing capability: no server-side decision function gates BFMR->Amazon auto-buy. Feature spends real money and MUST enforce, server-side and all-at-once: (1) sold AND shipped by Amazon.com only, (2) price <= per-reservation ceiling, (3) a designated card is set, (4) a designated saved address is set, plus dedupe (never re-order a reservation), a global kill switch, and an authorization gate (explicit per-order confirmation token OR the group's auto-buy opt-in). No such function exists (grep autoBuy/killSwitch/evaluateAutoBuy in lib -> none).

## Entry point

lib/autoBuyDecision.ts:1

## Required change

evaluateAutoBuy(reservation, group, offer, ctx) returns {approved, reasons[], cardId, savedAddressId, qty}; approved true ONLY when kill switch off, offer soldAndShippedByAmazon true, price present and <= reservation.maxPrice, card and savedAddress designated, not alreadyOrdered, and (confirmationToken present OR group.autoBuyEnabled). Any failing condition -> approved false with a reason.

Create the NEW file `lib/autoBuyDecision.ts`. Export the interfaces and a pure
function evaluateAutoBuy(reservation, group, offer, ctx): AutoBuyDecision where
AutoBuyDecision = {approved: boolean, reasons: string[], cardId: number|null,
savedAddressId: number|null, qty: number}.

Inputs:
- reservation: { id, requiredQty (BfmrReservation.qty), orderedQty (sum of
  OrderBfmrLink.quantity already linked), maxPrice: number|null }
- group: { cardId: number|null, savedAddressId: number|null, autoBuyEnabled: boolean }
- offer: { soldAndShippedByAmazon: boolean, price: number|null }
- ctx: { killSwitch: boolean, confirmationToken: string|null }

Rules the tests enforce (ALL must hold to approve; each failure appends a reason):
- PRIMARY GATE, checked first: remaining = requiredQty - orderedQty. If remaining
  <= 0 the reservation is already FILLED -> block. This is the double-order guard.
- The approved `qty` is the remaining-needed count (requiredQty - orderedQty),
  never more; qty is 0 when not approved.
- ctx.killSwitch true -> block (reason mentions "kill").
- offer.soldAndShippedByAmazon false -> block (reason mentions "Amazon").
- offer.price null -> block; reservation.maxPrice null -> block; price > maxPrice
  -> block. price EXACTLY == maxPrice is allowed (<=).
- group.cardId null -> block; group.savedAddressId null -> block.
- Authorization: block unless (ctx.confirmationToken is present) OR
  (group.autoBuyEnabled is true).
- approved is true only when reasons is empty; echo group.cardId/savedAddressId.
- Pure function: no I/O, no imports beyond the declared types.

## Must contain

- `export function evaluateAutoBuy`
- `soldAndShippedByAmazon`
- `killSwitch`
- `orderedQty`

(The gate holds the reference impl against this list. If the verify goes green
while one of these is absent from the changed files, the verify does not
enforce the spec -- that is a benign verify, caught mechanically.)

## Scope

Only edit `lib/autoBuyDecision.ts`; do not edit `verify.sh`, `verify.test.ts` or `TASK.md`.
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
