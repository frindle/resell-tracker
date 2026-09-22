# TASK: rt-bfmr-tracking-endorsement

## Confirmed defect (observed, not suspected)

CONFIRMED LIVE 2026-09-22 against production data. `selectCanonicalBfmrLinks` in
`lib/bfmrLinkReconcile.ts` collapses duplicate tracking numbers ORDER-WIDE: on a
trackingNumber collision it keeps only the link with the smallest id. That is
wrong when one Amazon order holds SEVERAL separate BFMR reservations whose units
ship together under ONE tracking number -- BFMR itself confirms this by putting
that same tracking number on each reservation row, and the current rule drops
the extra links anyway:

- Order 929: link 188 (reservation 307956, qty 3, value 1176, tracking
  9339589725268581127361) and link 189 (reservation 307955, qty 3, value 1176,
  same tracking). BOTH reservations carry that exact tracking number themselves.
  The current rule drops link 189, so `recalcBfmrSalePrice` returns 1176
  instead of the true 2352.
- Order 906 (the opposite case, must keep working): link 153 (reservation
  164353, status purchased, reservation trackingNumber NULL) shares tracking
  1Z82AA931379787130 with link 190 (reservation 238161, whose own
  trackingNumber IS 1Z82AA931379787130). Link 153 is a stale mislink and must
  still be dropped -- true total 1893, not 3155.
- Order 767 (same shape): links 104 and 105 sit on reservation 6480 whose own
  trackingNumber is 9339589725265621672225, yet they claim trackings
  9339589725265621788780 and 9339589725265622369872 which belong to
  reservations 216284 and 216283 respectively. Those two unendorsed links must
  be dropped so the order totals 1196 (4 x 299), not 1794.

## Entry point

lib/bfmrLinkReconcile.ts:15 (`selectCanonicalBfmrLinks`, step-2 collision rule)

## Required change

Resolve a tracking-number collision by RESERVATION ENDORSEMENT, not by link id.
A link is ENDORSED when its own reservation reports that same tracking number.
Within one normalized tracking group (trim + lowercase, treat empty string as no
tracking): first collapse links that share a reservationId down to the smallest
id; then, if any link in the group is endorsed, keep every endorsed link (one
per reservation) and drop all unendorsed ones; if NO link in the group is
endorsed, fall back to the existing behaviour and keep only the smallest id.

The `BfmrLinkLike` interface gains one optional field:
`reservationTracking?: string | null` -- the reservation row's OWN trackingNumber
as BFMR reported it. `undefined`/`null` means BFMR has not put a tracking number
on that reservation, which is NOT an endorsement (it must never count as one).

Untracked links and the existing step-1 parent-drop rule are unchanged. The
function must stay PURE (no prisma, no imports) and keep its generic signature
so `recalcBfmrSalePrice` can pass its richer link rows through unchanged.

Behaviour that must NOT change:
- Returns a SUBSET of the input array: same object identities, input order
  preserved; never mutates the input.
- Step 1 (parent-drop): for any reservationId with at least one tracked link,
  drop that reservation's untracked links; a reservation with no tracked link
  keeps its untracked link(s). Untracked survivors always pass through step 2.
- A group where NO link is endorsed behaves EXACTLY as before: only the smallest
  id survives (a link set with no `reservationTracking` data at all must produce
  identical output to the old implementation).
- Normalization: `(s ?? "").trim().toLowerCase()`; a link is "tracked" when its
  normalized trackingNumber is non-empty.

## Must contain

- `export interface BfmrLinkLike {`
- `reservationTracking?: string | null;`
- `export function selectCanonicalBfmrLinks<T extends BfmrLinkLike>(links: T[]): T[]`
- `normalize(l.reservationTracking)`

(The gate holds the reference impl against this list. If the verify goes green
while one of these is absent from the changed files, the verify does not
enforce the spec -- that is a benign verify, caught mechanically.)

(A bare bullet checks the default target. To PIN a literal to a specific file --
useful when a fix spans a helper file + the route/wiring that calls it --
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
