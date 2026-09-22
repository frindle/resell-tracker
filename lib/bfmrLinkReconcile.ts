// Canonical-link selection for BFMR reservations. Pure (no prisma): given the
// set of OrderBfmrLink rows recalcBfmrSalePrice is about to sum, drop the
// phantom links that inflate salePrice/bgExpectedPayout -- the no-tracking
// PARENT link left behind after a reservation is split into per-shipment tracked
// children, and any duplicate that re-uses a trackingNumber owned by another
// reservation.
//
// 2026-09-22: the duplicate-trackingNumber rule used to be ORDER-WIDE ("keep the
// smallest link id per tracking number"), which silently HALVED real orders. One
// Amazon order can hold several separate BFMR reservations whose units ship
// together under ONE tracking number, and BFMR confirms that by putting the same
// tracking number on each reservation row. Confirmed live on order 929: links 188
// (reservation 307956, qty 3, $1176) and 189 (reservation 307955, qty 3, $1176)
// both carry tracking 9339589725268581127361, both reservations report that
// tracking themselves, and the old rule dropped 189 — salePrice $1176 against a
// true payout of $2352, and every Save re-derived the same wrong number over
// whatever the user typed. The collision is now resolved by RESERVATION
// ENDORSEMENT instead of by link id, so the stale-mislink cases the rule was
// written for still collapse: order 906 link 153 (reservation 164353, no tracking
// of its own) still loses to link 190, and order 767 links 104/105 (reservation
// 6480, whose own tracking is a THIRD number) still lose to the reservations that
// actually own those trackings. Same scoping correction as the one applied to
// guardLink in lib/bfmrLinkGuard.ts on 2026-09-21.

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
