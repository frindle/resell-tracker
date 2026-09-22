#!/usr/bin/env python3
"""Reference impl for: rt-bfmr-tracking-endorsement

The gate applies this, runs the verify, and reverts it. It proves two things at
once: the task is SATISFIABLE as specified, and the verify actually ENFORCES
the spec (a refimpl that goes green while a "Must contain" literal is absent
means the verify is benign).

The whole existing module IS this slice's surface (interface + one pure
function), so the writer emits the complete corrected file: same header,
same step-1 parent-drop rule, plus the reservationTracking field and the
endorsement-based collision resolution in step 2.
"""
import pathlib
import sys

wt = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
p = wt / 'lib/bfmrLinkReconcile.ts'
p.parent.mkdir(parents=True, exist_ok=True)

NEW = """// Canonical-link selection for BFMR reservations. Pure (no prisma): given the
// set of OrderBfmrLink rows recalcBfmrSalePrice is about to sum, drop the
// phantom links that inflate salePrice/bgExpectedPayout -- the no-tracking
// PARENT link left behind after a reservation is split into per-shipment tracked
// children, and any duplicate that re-uses a trackingNumber already owned by
// another link. The dispatched task implements selectCanonicalBfmrLinks in THIS
// file only; recalc wiring is done separately by the reviewer.

export interface BfmrLinkLike {
  id: number;
  reservationId: number;
  trackingNumber: string | null;
  /** The reservation row's OWN trackingNumber as BFMR reported it. Optional: undefined/null means BFMR has not put a tracking number on that reservation, which is NOT an endorsement. */
  reservationTracking?: string | null;
}

const normalize = (s?: string | null) => (s ?? '').trim().toLowerCase();

export function selectCanonicalBfmrLinks<T extends BfmrLinkLike>(links: T[]): T[] {
  // 1. Per reservationId: if the reservation has at least one tracked link,
  //    drop that reservation's no-tracking "parent" link(s) -- superseded by
  //    the split. A reservation with NO tracked link keeps its no-tracking
  //    link (an un-split reservation must NOT be emptied).
  const reservationsWithTracked = new Set<number>();
  for (const l of links) {
    if (normalize(l.trackingNumber)) reservationsWithTracked.add(l.reservationId);
  }
  const parentDropped = links.filter(
    (l) => !reservationsWithTracked.has(l.reservationId) || normalize(l.trackingNumber),
  );

  // 2. Group the surviving tracked links by normalized trackingNumber and
  //    resolve each group: first collapse links that share a reservationId
  //    down to the smallest id, then keep every ENDORSED link -- one whose own
  //    reservation row reports that exact tracking number (one Amazon order can
  //    hold several reservations shipping together under ONE tracking number).
  //    If NO link in the group is endorsed, fall back to legacy behaviour:
  //    keep only the smallest id.
  const groups = new Map<string, T[]>();
  for (const l of parentDropped) {
    const key = normalize(l.trackingNumber);
    if (!key) continue;
    const g = groups.get(key);
    if (g) g.push(l); else groups.set(key, [l]);
  }

  const keepers = new Set<T>();
  for (const [key, group] of groups) {
    // a) same reservationId in one tracking group -> smallest id only.
    const byReservation = new Map<number, T>();
    for (const l of group) {
      const cur = byReservation.get(l.reservationId);
      if (!cur || l.id < cur.id) byReservation.set(l.reservationId, l);
    }
    // b/c) endorsement: the reservation row itself reports this tracking number.
    const endorsed = [...byReservation.values()].filter(
      (l) => normalize(l.reservationTracking) === key && key !== '',
    );
    if (endorsed.length > 0) {
      for (const l of endorsed) keepers.add(l);
    } else {
      // d) no endorsement data at all -- legacy: smallest id wins.
      let smallest = byReservation.values().next().value as T;
      for (const l of byReservation.values()) if (l.id < smallest.id) smallest = l;
      keepers.add(smallest);
    }
  }

  return parentDropped.filter((l) => !normalize(l.trackingNumber) || keepers.has(l));
}
"""

p.write_text(NEW)
print("refimpl applied")
