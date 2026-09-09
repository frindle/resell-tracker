# TASK: bfmr-link-guard

## Confirmed defect (observed, not suspected)

Order 907 showed 5 units reserved when only 3 were real. Cause: two
OrderBfmrLink rows on the SAME order carried the SAME tracking number (links
154 + 158, since deleted by hand), and nothing stops the summed link.quantity
for a single reservation from exceeding that reservation's `qty`. No write site
guards either invariant, so a re-run or a tracking-assign silently double-counts.

## Entry point

lib/bfmrAutoLink.ts:80 (the `prisma.orderBfmrLink.create` in the auto-link loop)
plus the manual POST in app/api/bfmr/links/route.ts.

## Required change

1. In `lib/bfmrAutoLink.ts`, add TWO exported, PURE (no DB, no I/O) functions,
   next to the existing `normDigits`:

   - `export function normTracking(s: string | null | undefined): string`
     returns the tracking normalized for comparison: whitespace removed,
     upper-cased; nullish/blank -> `''`.

   - `export function guardLink(orderLinks, p): { ok: true } | { ok: false; reason: string }`
     where
       `orderLinks: { id: number; reservationId: number; quantity: number; trackingNumber: string | null }[]`
       (ALL links currently on the proposed order) and
       `p: { orderId: number; reservationId: number; quantity: number;
             trackingNumber: string | null; reservationQty: number; excludeLinkId?: number }`.
     It must return `{ ok: false, reason }` when:
       (a) `normTracking(p.trackingNumber)` is non-empty AND some link in
           `orderLinks` (other than `excludeLinkId`) has the same
           `normTracking(...)` — the reason string MUST contain the words
           `duplicate tracking`; or
       (b) the sum of `quantity` over `orderLinks` whose `reservationId ===
           p.reservationId` (excluding `excludeLinkId`) PLUS `p.quantity`
           exceeds `p.reservationQty` — the reason MUST contain the word
           `over-allocated`.
     Otherwise `{ ok: true }`. `excludeLinkId` lets an in-place update skip
     comparing a link against itself.

2. Wire `guardLink` in at EVERY OrderBfmrLink write in scope, BEFORE the write:

   - **Auto-link create (lib/bfmrAutoLink.ts, ~line 80)**: before the
     `prisma.orderBfmrLink.create({...})`, load the order's current links
     (`prisma.orderBfmrLink.findMany({ where: { orderId }, select: { id, reservationId, quantity, trackingNumber } })`),
     call `guardLink(...)` with `reservationQty: r.qty`, and on `!guard.ok`
     `console.warn(...)` and `continue` (skip the create) — do NOT throw.

   - **Manual POST (app/api/bfmr/links/route.ts)**: import `guardLink` from
     `@/lib/bfmrAutoLink`. After the order/reservation are loaded and validated
     and BEFORE the create/update, load the order's links, call `guardLink`
     with `reservationQty: reservation.qty` (BfmrReservation has an integer
     `qty` field) and `excludeLinkId` set to the id of the link that POST would
     update in place (the existing (orderId,reservationId,trackingNumber)
     match), if any. On `!guard.ok`, `return Response.json({ error: guard.reason }, { status: 409 })`.

   You MAY also wire it into the split/assign paths in bfmrAutoLink.ts, but the
   two sites above are required.

## Behaviour that must NOT change

- A first, in-budget link with a unique tracking still links normally
  (auto-link and manual POST both still succeed on the happy path).
- Re-assigning a link its OWN tracking (in-place update) must NOT be rejected
  as a self-duplicate — that is what `excludeLinkId` is for.
- `normTracking` treats null, undefined and all-whitespace identically as `''`,
  so two untracked links never count as duplicates of each other.
- The qty budget counts ONLY links of the same reservation, never the whole
  order.

## Must contain

- `export function guardLink`
- `export function normTracking`
- `duplicate tracking`
- `over-allocated`
- `excludeLinkId`
- `reservationQty`

(The gate holds the reference impl against this list. If the verify goes green
while one of these is absent from the changed files, the verify does not
enforce the spec.)

## Scope

Only edit `lib/bfmrAutoLink.ts`, `app/api/bfmr/links/route.ts`; do not edit
`verify.sh`, `verify.test.ts` or `TASK.md`. verify.test.ts is the test fixture.

## Loop instruction

Run `bash verify.sh` after every edit and keep editing ONLY the two allowed
files until it prints `VERIFY_OK`.
