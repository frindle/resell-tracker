#!/usr/bin/env python3
"""Reference impl for: bfmrLinkReconcile-v2

Extends BfmrLinkLike with reserveId/quantity/lastSyncedAt and adds step 3 (twin
collapse) AFTER steps 1 and 2, operating on the links step 2 KEPT. Steps 1 and 2
are left byte-for-byte as they are.
"""
import pathlib
import sys

wt = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
p = wt / 'lib/bfmrLinkReconcile.ts'
t = p.read_text()


def sub(old, new):
    global t
    assert t.count(old) == 1, "refimpl anchor not found exactly once: " + old[:60]
    t = t.replace(old, new, 1)


sub("""  reservationTracking?: string | null;
}
""", """  reservationTracking?: string | null;
  /** The BfmrReservation row's reserveId (String?), mapped onto each link by the caller like reservationTracking. */
  reserveId?: string | null;
  /** OrderBfmrLink.quantity (Int). */
  quantity?: number | null;
  /** The BfmrReservation row's lastSyncedAt (DateTime), mapped onto each link by the caller. */
  lastSyncedAt?: string | Date | null;
}
""")

sub("""const normalize = (s?: string | null) => (s ?? '').trim().toLowerCase();
""", """const normalize = (s?: string | null) => (s ?? '').trim().toLowerCase();

// Missing or unparseable lastSyncedAt ranks OLDEST.
const syncedAt = (v?: string | Date | null): number => {
  const ms = v instanceof Date ? v.getTime() : v ? Date.parse(v) : NaN;
  return Number.isNaN(ms) ? -Infinity : ms;
};

// step 3 twin key: (normalized reserveId, normalized trackingNumber, quantity ?? null),
// or null when the link has no reserveId or no tracking (such links never group).
const twinKey = (l: BfmrLinkLike): string | null => {
  const reserve = normalize(l.reserveId);
  const tracking = normalize(l.trackingNumber);
  return reserve && tracking ? [reserve, tracking, l.quantity ?? null].join('\\u0001') : null;
};
""")

sub("""  return parentDropped.filter((l) => !normalize(l.trackingNumber) || keepers.has(l));
}""", """  const kept = parentDropped.filter((l) => !normalize(l.trackingNumber) || keepers.has(l));

  // 3. Twin collapse, on the links step 2 KEPT. BFMR now returns shipmentId, so
  //    sync-reservations creates a NEW reservation row (different reservationId)
  //    beside the old one with the SAME reserveId and the same tracking; both are
  //    endorsed, so step 2 keeps both and the sale price double-counts. Group by
  //    (normalized reserveId, normalized trackingNumber, quantity ?? null) and keep
  //    exactly one per group: the newest lastSyncedAt, tie or all missing -> smallest id.
  const winners = new Map<string, T>();
  for (const l of kept) {
    const key = twinKey(l);
    if (key === null) continue;
    const best = winners.get(key);
    if (!best || syncedAt(l.lastSyncedAt) > syncedAt(best.lastSyncedAt)
      || (syncedAt(l.lastSyncedAt) === syncedAt(best.lastSyncedAt) && l.id < best.id)) winners.set(key, l);
  }
  return kept.filter((l) => {
    const key = twinKey(l);
    return key === null || winners.get(key) === l;
  });
}""")
p.write_text(t)
print("refimpl applied")
