#!/usr/bin/env python3
"""Reference impl for: bfmr-stale-link-migration

The gate applies this, runs the verify, and reverts it. It proves two things at
once: the task is SATISFIABLE as specified, and the verify actually ENFORCES the
spec (a refimpl that goes green while a "Must contain" literal is absent means
the verify is benign).

Write the SIMPLEST change that makes the verify pass. It doubles as your review
reference when the model's diff comes back.
"""
import pathlib
import sys

wt = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
p = wt / 'lib/bfmrJoin.ts'
t = p.read_text()

# Anchor: the tail of matchSplitGroups, immediately before the web-backfill
# section. The new function sits NEXT TO matchSplitGroups per the intent.
OLD = r'''  return out;
}

// ---------------------------------------------------------------------------
// Web-backfill resolution (sync-reservations' myTrackerId fallback)'''

NEW = r'''  return out;
}

/**
 * Resolve stale OrderBfmrLink migrations: bare reservation rows that already
 * carry a link, whose live unlinked sibling should take it instead.
 *
 * The duplicate-on-purchase bug: a bare row (purchaseId=null, shipmentId=null)
 * with an OrderBfmrLink gets orphaned when BFMR assigns a purchaseId and the
 * sync creates a NEW local row for the now-purchased reservation instead of
 * updating the bare one in place. The link is left stranded on the dead row.
 * This returns which links to move -- {fromId: stale bare row, toId: live
 * unlinked sibling} -- and ONLY when the pairing is unambiguous.
 *
 * Group both sides by reserveId (null/empty reserveId cannot be grouped and is
 * skipped). A group emits a migration only with EXACTLY ONE bare-linked row AND
 * exactly one live-unlinked row whose qty equals the bare row's qty. Zero or >1
 * on either side resolves to NOTHING: a real BFMR split divides qty across
 * sibling rows, so it never produces an exact qty match here and must be left
 * untouched -- same "zero or ambiguous -> stay null" discipline as
 * matchSplitGroups above. Guessing is the wrong-reservation bug this module
 * already paid for once.
 */
export function resolveStaleReservationLinkMigrations(
  bareLinkedRows: Array<{ id: number; reserveId: string | null; qty: number }>,
  liveUnlinkedRows: Array<{ id: number; reserveId: string | null; qty: number }>,
): Array<{ fromId: number; toId: number }> {
  const bareGroups = new Map<string, typeof bareLinkedRows>();
  for (const b of bareLinkedRows || []) {
    if (!b.reserveId) continue;                    // ungroupable -> skip
    const g = bareGroups.get(b.reserveId);
    if (g) g.push(b); else bareGroups.set(b.reserveId, [b]);
  }
  const liveGroups = new Map<string, typeof liveUnlinkedRows>();
  for (const l of liveUnlinkedRows || []) {
    if (!l.reserveId) continue;                    // ungroupable -> skip
    const g = liveGroups.get(l.reserveId);
    if (g) g.push(l); else liveGroups.set(l.reserveId, [l]);
  }
  const out: Array<{ fromId: number; toId: number }> = [];
  for (const [reserveId, bareGroup] of bareGroups) {
    if (bareGroup.length !== 1) continue;          // >1 stale rows -> never guess
    const liveGroup = liveGroups.get(reserveId);
    if (!liveGroup) continue;                      // no live sibling -> nothing to move
    const matches = liveGroup.filter(l => l.qty === bareGroup[0].qty);
    if (matches.length !== 1) continue;            // 0 or ambiguous -> stay put
    out.push({ fromId: bareGroup[0].id, toId: matches[0].id });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Web-backfill resolution (sync-reservations' myTrackerId fallback)'''

assert OLD in t, "refimpl anchor not found -- did the target change?"
p.write_text(t.replace(OLD, NEW, 1))
print("refimpl applied")
