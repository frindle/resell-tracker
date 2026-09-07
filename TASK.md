# TASK: bfmr-split-shipment-state

## Confirmed defect (observed, not suspected)

On the order-detail page's "BFMR Reservations" panel, a SPLIT reservation shows
the wrong shipment state per link. Example: a qty-2 reservation split into a
2-unit link (has tracking, shipped) + a 1-unit link (no tracking, awaiting
tracking). BOTH link cards render "Fully submitted to BFMR — 2 of 2 shipped." —
including the pending one, which must NOT say fully submitted/shipped.

Root cause: `components/BfmrReservationLinker.tsx` (~line 632). The
`Fully submitted to BFMR — {r.qty} of {r.qty} shipped.` branch is gated on the
RESERVATION-level `r.remainingQty <= 0` but rendered PER-LINK. Once the shipped
sibling consumes the reservation's remaining qty, the other (un-shipped) link
inherits the same message. The count is also hardcoded `{r.qty} of {r.qty}`, so
it can never show a partial. This is the same bug class `linkStatusLabel` (same
file, ~lines 66-80) already fixed for the status BADGE by making it per-link;
this branch was never made per-link too.

## Entry point

- `components/BfmrReservationLinker.tsx:632` — the
  `{r.remainingQty <= 0 ? ( ... Fully submitted to BFMR — {r.qty} of {r.qty}
  shipped. ... ) : ( ... )}` render site inside the `linksForThisOrder.map(l =>
  { ... })` body.
- `components/BfmrReservationLinker.tsx:66` — `linkStatusLabel`, the existing
  per-link extraction to mirror for the shipped notion.

## Required change

1. NEW pure module `lib/bfmrLinkSubmission.ts`, mirroring `lib/bfmrPushGate.ts`'s
   extract-for-testability pattern:
   - `export interface LinkSubmissionState { shipped: boolean; submittedUnits:
     number; totalUnits: number; }`
   - `export function linkSubmissionState(link: { trackingNumber: string | null;
     quantity: number }, reservation: { qty: number; remainingQty: number;
     trackingNumber: string | null; status?: string }): LinkSubmissionState`
   - `shipped` is PER-LINK, using the SAME notion as `linkStatusLabel`:
     `!!link.trackingNumber || (link.quantity >= reservation.qty &&
     !!reservation.trackingNumber)`. It must NOT depend on reservation-level
     `remainingQty`.
   - `submittedUnits` = the accurate reservation units already submitted
     (`reservation.qty - reservation.remainingQty`, clamped to `[0, qty]`);
     `totalUnits` = `reservation.qty`.
   - Document WHY (per-link, not reservation-level; the split-shipment bug).

2. EDIT `components/BfmrReservationLinker.tsx`:
   - Add `import { linkSubmissionState } from '@/lib/bfmrLinkSubmission';`.
   - Inside the `linksForThisOrder.map(l => { ... })` body, alongside the other
     per-link helper calls (`linkStatusLabel(l, r)` etc.), add
     `const submission = linkSubmissionState(l, r);`.
   - At the render site, change the gate from `{r.remainingQty <= 0 ? (` to
     `{submission.shipped ? (` so the "Fully submitted" message is PER-LINK.
   - Change the count from `{r.qty} of {r.qty} shipped.` to
     `{submission.submittedUnits} of {submission.totalUnits} shipped.`.
   - Change NOTHING ELSE (the `else` submit UI stays as-is).

3. NEW test `lib/bfmrLinkSubmission.test.ts` in the exact style of
   `lib/bfmrPushGate.test.ts` (`import test from 'node:test'`,
   `import assert from 'node:assert/strict'`, `.ts` relative import). Adversarial
   cases that matter: the SPLIT case (qty-2 reservation, remainingQty 0; link A
   qty2 WITH tracking → shipped; link B qty1 WITHOUT tracking → NOT shipped,
   the bug); a fully-shipped single link; a not-yet-submitted single link; and a
   whole-cover link with NO reservation tracking → NOT shipped (over-trigger
   guard).

4. Wire `lib/bfmrLinkSubmission.test.ts` into the `package.json` `"test"` script
   by APPENDING it to the SINGLE existing `node --experimental-strip-types
   --test ...` line (which already ends with `lib/autoSubmitChannel.test.ts`).
   Do NOT create a second test line — both new test files share the one line.

Behaviour that must NOT change:
- The status BADGE (`linkStatusLabel`) and the `else`-branch submit UI are
  untouched.
- The existing test suite stays green.

## Must contain

- `export interface LinkSubmissionState`
- `export function linkSubmissionState(`
- `linkSubmissionState(l, r)`
- `from '@/lib/bfmrLinkSubmission'`
- `submission.shipped`
- `submission.submittedUnits`

## Scope

Only edit `lib/bfmrLinkSubmission.ts`, `components/BfmrReservationLinker.tsx`,
`lib/bfmrLinkSubmission.test.ts`, and `package.json`. Do not edit `verify.sh`,
`TASK.md`, or any other file.

## Loop instruction

Run `bash verify.sh` after every edit and keep editing until it prints
`VERIFY_OK`. Fix each named FAIL in turn; do not edit `verify.sh` to make it pass.
