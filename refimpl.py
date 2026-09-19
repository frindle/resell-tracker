#!/usr/bin/env python3
"""Reference impl for: bfmrJoin

The gate applies this, runs the verify, and reverts it. It proves two things at
once: the task is SATISFIABLE as specified, and the verify actually ENFORCES the
spec (a refimpl that goes green while a "Must contain" literal is absent means
the verify is benign).

The change: append a pure `matchSplitGroups` to lib/bfmrJoin.ts that resolves a
split commitment by SUMMING its halves' quantities against one web row, and
refuses to resolve on zero or ambiguous matches. bfmrJoinKey is deliberately left
byte-identical -- this ADDS a second path rather than loosening the first.
"""
import pathlib
import sys

wt = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
p = wt / 'lib/bfmrJoin.ts'
t = p.read_text()

ANCHOR = """export function buildOrderIdTrackerRow("""

ADDITION = """/**
 * Group key for a SPLIT commitment: the two fields a split cannot change.
 *
 * Deliberately drops qty AND order_id -- those are exactly the fields that vary
 * between halves of one split, which is why bfmrJoinKey (which keeps both, on
 * purpose, for the 1:1 case) can never resolve one.
 */
export function bfmrSplitGroupKey(row: {
  reserved_at?: unknown;
  item_model_number?: unknown;
  item_name?: unknown;
}): string {
  const item = String(row.item_model_number || row.item_name || '').trim().toLowerCase();
  return [normalizeBfmrTimestamp(row.reserved_at), item].join('|');
}

/**
 * Resolve split commitments: local rows whose qtys SUM to one web row's qty.
 *
 * A BFMR commitment split across >1 local reservation rows is ONE web row (one
 * my_tracker_id) whose quantity was divided. Each half carries a partial qty and
 * its own order_id, so each half matches the web row on neither -- leaving
 * myTrackerId null forever and every tracking submit 409ing.
 *
 * Only groups of >= 2 locals are considered: a lone row is the ordinary 1:1
 * path's business, and both paths claiming one row would silently double up the
 * "exactly one match" discipline.
 *
 * Zero or >1 candidate web rows resolves to NOTHING. Two genuinely different
 * commitments at the same instant, same item, same summed qty are
 * indistinguishable here, and guessing is the wrong-reservation bug this module
 * already paid for once.
 */
export function matchSplitGroups(
  locals: Array<{
    id: number;
    reserved_at?: unknown;
    item_model_number?: unknown;
    item_name?: unknown;
    qty?: unknown;
  }>,
  webRows: Array<{
    reserved_at?: unknown;
    item_model_number?: unknown;
    item_name?: unknown;
    qty?: unknown;
    my_tracker_id?: unknown;
  }>,
): Array<{ id: number; my_tracker_id: number }> {
  const groups = new Map<string, typeof locals>();
  for (const l of locals || []) {
    const k = bfmrSplitGroupKey(l);
    const g = groups.get(k);
    if (g) g.push(l); else groups.set(k, [l]);
  }
  const out: Array<{ id: number; my_tracker_id: number }> = [];
  for (const [key, group] of groups) {
    if (group.length < 2) continue;                 // 1:1 is the other path's job
    let sum = 0;
    let ok = true;
    for (const l of group) {
      const q = parseInt(String(l.qty ?? ''), 10);
      if (Number.isNaN(q)) { ok = false; break; }
      sum += q;
    }
    if (!ok) continue;
    const candidates = (webRows || []).filter(w => {
      const wq = parseInt(String(w.qty ?? ''), 10);
      return bfmrSplitGroupKey(w) === key && !Number.isNaN(wq) && wq === sum
        && w.my_tracker_id != null && Number(w.my_tracker_id) > 0;
    });
    if (candidates.length !== 1) continue;          // 0 or ambiguous -> stay null
    const tid = Number(candidates[0].my_tracker_id);
    for (const l of group) out.push({ id: l.id, my_tracker_id: tid });
  }
  return out;
}

"""

assert ANCHOR in t, "refimpl anchor not found -- did the target change?"
assert "matchSplitGroups" not in t, "target already has matchSplitGroups"
p.write_text(t.replace(ANCHOR, ADDITION + ANCHOR, 1))
print("refimpl applied")
