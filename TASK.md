# TASK: bfmr-stale-link-wiring

## Confirmed defect (observed, not suspected)

`resolveStaleReservationLinkMigrations(bareLinkedRows, liveUnlinkedRows)` already
landed in `lib/bfmrJoin.ts` (pure resolver: emits a `{fromId, toId}` migration only
when exactly one bare row and exactly one qty-matching live sibling share a
reserve_id), but the sync-reservations POST route never calls it. Observed in the
route source as of this baseline: `app/api/bfmr/sync-reservations/route.ts` imports
only `normalizeBackfillLocal, resolveTrackerBackfill` from `@/lib/bfmrJoin`, and a
grep for `resolveStaleReservationLinkMigrations` finds zero references outside
`lib/bfmrJoin.ts`. Consequence: reservations that went bare (purchaseId/shipmentId
nulled) while still holding OrderBfmrLinks keep pointing at the stale row forever,
and their live siblings stay unlinked -- no reconciliation step exists anywhere in
the sync.

## Entry point

app/api/bfmr/sync-reservations/route.ts:326 (the `return Response.json({` that ends
the POST handler; the new reconciliation step goes immediately before it, i.e. AFTER
the upsert loop and the web-backfill block)

## Required change

Wire the existing resolveStaleReservationLinkMigrations(bareLinkedRows, liveUnlinkedRows) function (already landed in lib/bfmrJoin.ts, import it from there -- do not redefine it) into the sync-reservations POST route as a reconciliation step run AFTER the existing main upsert loop and the web-backfill block. It must: (1) query bareLinkedRows via prisma.bfmrReservation.findMany({ where: { userId: uid, purchaseId: null, shipmentId: null, orderLinks: { some: {} } }, select: { id: true, reserveId: true, qty: true } }); (2) query liveUnlinkedRows via prisma.bfmrReservation.findMany({ where: { userId: uid, OR: [{ purchaseId: { not: null } }, { shipmentId: { not: null } }], orderLinks: { none: {} } }, select: { id: true, reserveId: true, qty: true } }); (3) call resolveStaleReservationLinkMigrations(bareLinkedRows, liveUnlinkedRows); (4) for each returned {fromId, toId}, run prisma.orderBfmrLink.updateMany({ where: { reservationId: fromId }, data: { reservationId: toId } }) -- this moves the OrderBfmrLink(s) off the stale bare row onto its live sibling; do NOT delete or otherwise modify the stale bare row itself; (5) add the result to this route's existing JSON response, following its established diagnostic-field pattern (e.g. synced, autoLinked, webBackfilled already in that response): add staleLinkMigrations: <count> plus a capped sample array (cap 10) of the {fromId,toId} pairs actually applied, named staleLinkMigrationSamples, only included when non-empty (matching how collisionSamples/staleLinkValueSamples are conditionally spread into the response elsewhere in this same route).

Behaviour that must NOT change:
- The existing response fields stay exactly as they are: `synced`, `autoLinked`,
  `fetched`, `unique`, `reserveIdCollisions`, `webBackfilled`, `webAmbiguous`,
  `webUnmatched`, `webNeeded`, `webBackfillSkipped`, `webRows`, and the conditional
  spreads (`collisionSamples`, `staleLinkValueSamples`, etc.).
- The upsert loop, web-backfill block, auto-link step, and stale-link-value
  reporting all keep their current behaviour; every query stays scoped to
  `userId: uid` exactly like the rest of this route.
- The stale bare row itself is never deleted or modified -- only its OrderBfmrLink(s)
  move onto the live sibling.

## Must contain

- in app/api/bfmr/sync-reservations/route.ts: `resolveStaleReservationLinkMigrations } from '@/lib/bfmrJoin'`
- in app/api/bfmr/sync-reservations/route.ts: `orderLinks: { some: {} }`
- in app/api/bfmr/sync-reservations/route.ts: `orderLinks: { none: {} }`
- in app/api/bfmr/sync-reservations/route.ts: `const staleLinkMigrations = resolveStaleReservationLinkMigrations(bareLinkedRows, liveUnlinkedRows);`
- in app/api/bfmr/sync-reservations/route.ts: `await prisma.orderBfmrLink.updateMany({ where: { reservationId: m.fromId }, data: { reservationId: m.toId } });`
- in app/api/bfmr/sync-reservations/route.ts: `staleLinkMigrations: staleLinkMigrations.length,`
- in app/api/bfmr/sync-reservations/route.ts: `...(staleLinkMigrations.length ? { staleLinkMigrationSamples: staleLinkMigrations.slice(0, 10) } : {}),`

## Scope

Only edit `app/api/bfmr/sync-reservations/route.ts`; do not edit `verify.sh`, `test_fixture.py` or `TASK.md`.
test_fixture.py is the test fixture -- changing it invalidates the check.

## Keep every changed line exercised (relevance)

After the job runs, a mutation check flips/deletes each line you changed and
asks the verify to catch it. A changed line whose every mutant survives --
because no test asserts it -- FAILS the gate even when the fix is correct, and
the review never runs. So do NOT emit an isolated, untested line:
- Fold an unavoidable constant onto a line the test already exercises. Put a
  `timeout=` / a `daemon=True` flag / a small tuning number on the SAME line as a
  header dict, URL, or argument the fixture checks -- never on its own line.
- Prefer falling through to an implicit `return None` over a standalone
  `return None` in an `except:` the tests do not assert.
- If a line genuinely cannot be asserted and cannot be folded, it usually
  should not be a separate line at all -- restructure so it isn't.
This is not about adding bogus assertions for constants; it is about not
leaving a lone line that carries no tested behaviour.

## Loop instruction

Run `bash verify.sh` after every edit and keep editing until it prints
`VERIFY_OK`.
