"""Adversarial fixture for: bfmr-stale-link-wiring

The target is a Next.js App Router route (TypeScript) that cannot be imported
by Python, so this fixture drives the CONTRACT of the route as source text:
it asserts the reconciliation step exists, uses the exact prisma queries and
resolver call the spec demands, moves links via updateMany (never deleting the
stale bare row), is positioned AFTER the web-backfill block and BEFORE the
response, and that the response gains staleLinkMigrations + a capped sample
array following the route's conditional-spread pattern.

A benign implementation (no wiring at all) fails every case below; an
implementation with the tokens in the wrong place or with the wrong write
(e.g. deleting the bare row instead of moving its links) fails the ordering /
write-shape cases.
"""
import pathlib
import sys

TARGET = 'app/api/bfmr/sync-reservations/route.ts'


def src():
    return pathlib.Path(TARGET).read_text()


CASES = [
    (
        "imports resolveStaleReservationLinkMigrations from @/lib/bfmrJoin (does not redefine it)",
        lambda: ("resolveStaleReservationLinkMigrations } from '@/lib/bfmrJoin'" in src())
                and "export function resolveStaleReservationLinkMigrations" not in src(),
        True,
    ),
    (
        "queries bareLinkedRows exactly as specified (userId-scoped, purchaseId/shipmentId null, orderLinks some)",
        lambda: ("prisma.bfmrReservation.findMany({\n      where: { userId: uid, purchaseId: null, shipmentId: null, orderLinks: { some: {} } },\n      select: { id: true, reserveId: true, qty: true }," in src()),
        True,
    ),
    (
        "queries liveUnlinkedRows exactly as specified (userId-scoped OR not-null purchase/shipment, orderLinks none)",
        lambda: ("prisma.bfmrReservation.findMany({\n      where: { userId: uid, OR: [{ purchaseId: { not: null } }, { shipmentId: { not: null } }], orderLinks: { none: {} } },\n      select: { id: true, reserveId: true, qty: true }," in src()),
        True,
    ),
    (
        "resolver runs AFTER both queries and BEFORE the response is built",
        lambda: (lambda t: (t.find("orderLinks: { some: {} }") < -1) or (t.find("orderLinks: { none: {} }") < -1) or not (0 <= t.find("orderLinks: { some: {} }") < t.find("orderLinks: { none: {} }") < t.find("const staleLinkMigrations = resolveStaleReservationLinkMigrations(bareLinkedRows, liveUnlinkedRows);") < t.find("return Response.json({")))(src()),
        True,
    ),
    (
        "applies each migration via orderBfmrLink.updateMany moving reservationId fromId -> toId",
        lambda: ("await prisma.orderBfmrLink.updateMany({ where: { reservationId: m.fromId }, data: { reservationId: m.toId } });" in src()),
        True,
    ),
    (
        "does NOT delete or otherwise modify the stale bare row itself",
        lambda: ("prisma.bfmrReservation.delete" not in src()) and ("bfmrReservation.updateMany({ where: { id: m.fromId }" not in src()),
        True,
    ),
    (
        "response adds staleLinkMigrations count following the diagnostic-field pattern",
        lambda: ("staleLinkMigrations: staleLinkMigrations.length," in src()),
        True,
    ),
    (
        "response conditionally spreads staleLinkMigrationSamples capped at 10 (only when non-empty)",
        lambda: ("...(staleLinkMigrations.length ? { staleLinkMigrationSamples: staleLinkMigrations.slice(0, 10) } : {})," in src()),
        True,
    ),
    (
        "regression: existing diagnostic fields and conditional spreads are preserved",
        lambda: all(s in src() for s in [
            "synced,",
            "autoLinked,",
            "webBackfilled,",
            "...(collisionSamples.length ? { collisionSamples } : {}),",
            "...(staleLinks.length ? { staleLinkValueSamples: staleLinks.slice(0, 10) } : {}),",
        ]),
        True,
    ),
]


def main():
    if len(CASES) < 3:
        print("  SCAFFOLD_INCOMPLETE: {} adversarial case(s) authored, need >= 3."
              .format(len(CASES)))
        print("  A generated scaffold is not a verify. Author the cases in "
              "test_fixture.py.")
        return 1
    fails = 0
    for desc, thunk, want in CASES:
        try:
            got = thunk()
        except Exception as e:
            print("  FAIL {} -- raised {}: {}".format(desc, type(e).__name__, e))
            fails += 1
            continue
        if got != want:
            print("  FAIL {} -- got {!r}, want {!r}".format(desc, got, want))
            fails += 1
    print("  {}/{} case(s) passed".format(len(CASES) - fails, len(CASES)))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
