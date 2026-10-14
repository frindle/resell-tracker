# TASK: bfmrLinkReconcile-v2

## Confirmed defect (observed, not suspected)

BEHAVIOR TO ADD (no defect observed at baseline): `selectCanonicalBfmrLinks` does not extend `BfmrLinkLike` with `reserveId`, `quantity`, or `lastSyncedAt`; it does not perform a step 3 (reserveId-based twin collapse). At baseline `lib/bfmrLinkReconcile.ts` does not contain these fields or this logic.

## Entry point

lib/bfmrLinkReconcile.ts:1

## Required change

selectCanonicalBfmrLinks (lib/bfmrLinkReconcile.ts) collapses duplicates only by reservationId. BFMR now returns shipmentId, so sync-reservations creates NEW BfmrReservation ROWS (different reservationId) beside the old ones with the SAME reserveId, both carrying the same tracking number; auto-link links both twins and recalcBfmrSalePrice sums both (4 x 1173 = 4692 instead of 2346). FIELD FACTS (real source): link.quantity is the real OrderBfmrLink.quantity (Int); reserveId and lastSyncedAt live on the BfmrReservation row (reserveId String?, lastSyncedAt DateTime), so the caller maps them onto each link exactly like reservationTracking is mapped today (lib/bfmrSalePrice.ts: ownedLinks.map(l => ({...l, reservationTracking: l.reservation.trackingNumber}))). So extend BfmrLinkLike with optional reserveId?: string|null, quantity?: number|null, lastSyncedAt?: string|Date|null -- use EXACTLY these names; do not invent others (no reservationLastSyncedAt). CHANGE: keep steps 1 (parent drop) and 2 (tracking groups: same-reservationId collapse, endorsement, legacy smallest-id fallback) EXACTLY as they are; add a step 3 that runs on the links step 2 KEPT: among kept links with a non-empty normalized reserveId and a non-empty tracking, group by (normalized reserveId, normalized trackingNumber, quantity ?? null); inside a group that has more than one link (necessarily different reservationIds), keep exactly ONE: the link with the newest lastSyncedAt (Date or ISO string parsed to a time; missing/invalid ranks oldest); tie or all missing -> smallest id. Drop the others. Links with no/empty reserveId, no tracking, or a unique key pass through unchanged. Return the survivors in the original input order. IMPORTANT FOR FIXTURES: step 2 keeps BOTH twins only when each twin's reservationTracking equals its trackingNumber (endorsed, the realistic twin case: both reservation rows report the tracking). Unendorsed same-tracking links are already collapsed to the smallest id by step 2 and must stay that way (existing behaviour). So every twin / real-split / order-929-style fixture that must keep or pick between BOTH links MUST set reservationTracking === trackingNumber on both, otherwise step 2 removes one before step 3 runs. Twins must have DIFFERENT reservationId and the SAME reserveId. MUST STILL KEEP ALL (sum): real splits (same reserveId, different tracking OR different quantity, each link endorsed); order-929 (different reserveIds, same tracking, both endorsed); links with no reserveId (both endorsed, same tracking -> both kept). Existing behaviours in lib/bfmrLinkReconcile.test.ts (parent drop, orders 906/767/929) must not change. Import in tests: import { selectCanonicalBfmrLinks, type BfmrLinkLike } from './lib/bfmrLinkReconcile.ts'. Only edit lib/bfmrLinkReconcile.ts.

Behaviour that must NOT change:
- Step 1 (parent drop): if a reservation has at least one tracked link, drop that reservation's no-tracking "parent" link(s); a reservation with NO tracked link keeps its no-tracking link.
- Step 2 (tracking groups): same-reservationId collapse (smallest id), endorsement (reservation row reports the tracking), legacy smallest-id fallback when no link is endorsed.
- Order 906: link 153 (reservation 164353, no tracking of its own) still loses to link 190.
- Order 767: links 104/105 (reservation 6480, whose own tracking is a THIRD number) still lose to the reservations that actually own those trackings.
- Order 929: links 188 (reservation 307956, qty 3, $1176) and 189 (reservation 307955, qty 3, $1176) both carry tracking 9339589725268581127361, both reservations report that tracking, and both are kept (endorsed).

## Must contain

- `reserveId`
- `quantity`
- `lastSyncedAt`
- `BfmrLinkLike`
- `selectCanonicalBfmrLinks`
- `step 3`
- `normalized reserveId`
- `normalized trackingNumber`
- `newest lastSyncedAt`
- `smallest id`
- `reservationTracking`
- `reservationId`
- `trackingNumber`

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
