#!/usr/bin/env python3
"""Reference impl for: bfmr-stale-link-wiring

The gate applies this, runs the verify, and reverts it. It proves two things at
once: the task is SATISFIABLE as specified, and the verify actually ENFORCES the
spec (a refimpl that goes green while a "Must contain" literal is absent means
the verify is benign).

Two surgical edits to app/api/bfmr/sync-reservations/route.ts -- everything
already in the file is preserved:
  1. extend the existing bfmrJoin import with resolveStaleReservationLinkMigrations
  2. insert the reconciliation step after the stale-link-value block (i.e. AFTER
     the upsert loop and the web-backfill block) and add the two diagnostic
     fields to the response, following the route's conditional-spread pattern.
"""
import pathlib
import sys

wt = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
p = wt / 'app/api/bfmr/sync-reservations/route.ts'
t = p.read_text()

OLD_IMPORT = r"import { normalizeBackfillLocal, resolveTrackerBackfill } from '@/lib/bfmrJoin';"
NEW_IMPORT = (r"import { normalizeBackfillLocal, resolveTrackerBackfill,"
              r" resolveStaleReservationLinkMigrations } from '@/lib/bfmrJoin';")

OLD_ANCHOR = r"""  return Response.json({
    synced,
    autoLinked,"""
NEW_BLOCK = r"""  // Reconcile stale OrderBfmrLinks: a reservation that went bare (no
  // purchaseId/shipmentId) while still holding links is the stale twin of a
  // live sibling row for the same reserve_id -- move its links onto the live
  // row. The resolver in lib/bfmrJoin.ts only emits a migration when exactly
  // one bare and exactly one qty-matching live row share a reserveId; anything
  // ambiguous stays put ("loudly wrong, not silently wrong"). The stale bare
  // row itself is never deleted or modified -- only its links move.
  const [bareLinkedRows, liveUnlinkedRows] = await Promise.all([
    prisma.bfmrReservation.findMany({
      where: { userId: uid, purchaseId: null, shipmentId: null, orderLinks: { some: {} } },
      select: { id: true, reserveId: true, qty: true },
    }),
    prisma.bfmrReservation.findMany({
      where: { userId: uid, OR: [{ purchaseId: { not: null } }, { shipmentId: { not: null } }], orderLinks: { none: {} } },
      select: { id: true, reserveId: true, qty: true },
    }),
  ]);
  const staleLinkMigrations = resolveStaleReservationLinkMigrations(bareLinkedRows, liveUnlinkedRows);
  for (const m of staleLinkMigrations) {
    await prisma.orderBfmrLink.updateMany({ where: { reservationId: m.fromId }, data: { reservationId: m.toId } });
  }

  return Response.json({
    synced,
    autoLinked,"""

assert OLD_IMPORT in t, "refimpl anchor (import) not found -- did the target change?"
t = t.replace(OLD_IMPORT, NEW_IMPORT, 1)
assert OLD_ANCHOR in t, "refimpl anchor (response) not found -- did the target change?"
t = t.replace(OLD_ANCHOR, NEW_BLOCK, 1)

OLD_RESP = r"""    staleLinkValues: staleLinks.length,
    ...(staleLinks.length ? { staleLinkValueSamples: staleLinks.slice(0, 10) } : {}),
  });"""
NEW_RESP = r"""    staleLinkValues: staleLinks.length,
    ...(staleLinks.length ? { staleLinkValueSamples: staleLinks.slice(0, 10) } : {}),
    // Stale bare rows whose OrderBfmrLinks were moved onto their live sibling
    // this pass. Samples are capped so the response stays small on a large
    // reconciliation; omitted entirely when nothing migrated.
    staleLinkMigrations: staleLinkMigrations.length,
    ...(staleLinkMigrations.length ? { staleLinkMigrationSamples: staleLinkMigrations.slice(0, 10) } : {}),
  });"""
assert OLD_RESP in t, "refimpl anchor (response fields) not found -- did the target change?"
t = t.replace(OLD_RESP, NEW_RESP, 1)

p.write_text(t)
print("refimpl applied")
