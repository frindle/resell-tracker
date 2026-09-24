#!/usr/bin/env python3
"""Reference impl for: rt-bfmr-sync-scope-wiring-v2

The gate applies this, runs the verify, and reverts it. It proves two things at
once: the task is SATISFIABLE as specified, and the verify actually ENFORCES
the spec.

Writes lib/bfmrSyncTrigger.ts (the decision module) and applies the structural
wiring edits the pins force: route.ts composes resolveBfmrSyncPlan(
scopeForSyncTrigger(body?.trigger)), takes its filters from the plan and gates
the web-backfill scrape on plan.runWebBackfill; the linker's auto-sync fetch
sends { trigger: 'order-open' }. lib/autoSync.ts is left untouched (no body ->
'all'). Idempotent: each step is skipped if its target content is already
present. lib/bfmrSyncScope.ts already exists on main and is NOT touched.
"""
import pathlib
import sys

wt = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")


# --- lib/bfmrSyncTrigger.ts (the decision module -- always the full body) ----
TRIGGER_TS = r'''// Decides WHICH sync scope each caller of POST /api/bfmr/sync-reservations is
// entitled to. Pure: no DB, no network, no clock. The scope-plan module is
// imported TYPE-ONLY so this stays a leaf with no runtime dependencies.
import type { BfmrSyncScope } from './bfmrSyncScope';

export type BfmrSyncTrigger = 'order-open' | 'manual' | 'scheduled';

// The frozen trigger->scope policy. Object.freeze is load-bearing: a caller
// that mutates the mapping would silently re-point a trigger (e.g. narrowing
// the scheduled sync so the myTrackerId web backfill never runs again).
export const SYNC_TRIGGER_SCOPES: Readonly<Record<BfmrSyncTrigger, BfmrSyncScope>> = Object.freeze({
  'order-open': 'pending', // the narrow, cheap pull -- ONLY this trigger gets it
  manual: 'all',           // full status enum + web backfill must keep running
  scheduled: 'all',        // same: the background sync is where the backfill converges
});

// Fail-safe direction: an unknown trigger must never silently NARROW a sync.
// Total and non-throwing -- undefined, null, '', case variants, numbers and
// objects all fall through to 'all'.
export function scopeForSyncTrigger(trigger: unknown): BfmrSyncScope {
  if (trigger === 'order-open' || trigger === 'manual' || trigger === 'scheduled') return SYNC_TRIGGER_SCOPES[trigger];
  return 'all';
}
'''

# --- route.ts wiring ----------------------------------------------------------
ROUTE_IMPORT_OLD = """import { reservationLineKey } from '@/lib/bfmrReservationLineKey';
"""
ROUTE_IMPORT_NEW = """import { reservationLineKey } from '@/lib/bfmrReservationLineKey';
import { resolveBfmrSyncPlan } from '@/lib/bfmrSyncScope';
import { scopeForSyncTrigger } from '@/lib/bfmrSyncTrigger';
"""

ROUTE_FILTERS_OLD = """  const filters: TrackerFilter[] = [
    {
      status: 'purchased,reserved,return,payment_error,shipped,processed,set_aside,paid,cancelled,returned,closed,deadline,pkg_received',
      page_size: 200,
    },
  ];
"""
ROUTE_FILTERS_NEW = """  // Scope decision lives in lib/bfmrSyncTrigger.ts (pure): 'order-open' is the
  // only trigger entitled to the narrow pull; manual/scheduled/absent keep the
  // full status enum so the myTrackerId web backfill still converges. The
  // filters + backfill/scan flags come from lib/bfmrSyncScope.ts's plan.
  const body = await req.json().catch(() => null) as { trigger?: unknown } | null;
  const plan = resolveBfmrSyncPlan(scopeForSyncTrigger(body?.trigger));
  const filters: TrackerFilter[] = plan.filters;
"""

ROUTE_GATE_OLD = """  if (needsWebBackfill.length > 0) {
"""
ROUTE_GATE_NEW = """  if (plan.runWebBackfill && needsWebBackfill.length > 0) {
"""

# --- linker wiring -------------------------------------------------------------
LINKER_FETCH_OLD = """        fetch('/api/bfmr/sync-reservations', { method: 'POST' })
          .then(() => load())"""
LINKER_FETCH_NEW = """        // The order-open path is the ONLY caller entitled to the narrow scope;
        // the route maps it via scopeForSyncTrigger('order-open') -> 'pending'.
        fetch('/api/bfmr/sync-reservations', { method: 'POST', body: JSON.stringify({ trigger: 'order-open' }) })
          .then(() => load())"""


def _patch(path: pathlib.Path, old: str, new: str, marker: str) -> None:
    t = path.read_text()
    if marker in t and old not in t:
        print(f"  skip (already wired): {path} [{marker}]")
        return
    assert old in t, f"refimpl anchor not found in {path} -- did the file change?\n{old}"
    path.write_text(t.replace(old, new, 1))
    print(f"  patched: {path} [{marker}]")


def main() -> None:
    tgt = wt / 'lib' / 'bfmrSyncTrigger.ts'
    tgt.parent.mkdir(parents=True, exist_ok=True)
    tgt.write_text(TRIGGER_TS)
    print("  wrote lib/bfmrSyncTrigger.ts")

    route = wt / 'app' / 'api' / 'bfmr' / 'sync-reservations' / 'route.ts'
    _patch(route, ROUTE_IMPORT_OLD, ROUTE_IMPORT_NEW, "from '@/lib/bfmrSyncTrigger'")
    _patch(route, ROUTE_FILTERS_OLD, ROUTE_FILTERS_NEW, "resolveBfmrSyncPlan(scopeForSyncTrigger(")
    _patch(route, ROUTE_GATE_OLD, ROUTE_GATE_NEW, "plan.runWebBackfill && needsWebBackfill.length > 0")

    linker = wt / 'components' / 'BfmrReservationLinker.tsx'
    _patch(linker, LINKER_FETCH_OLD, LINKER_FETCH_NEW, "trigger: 'order-open'")

    print("refimpl applied")


if __name__ == '__main__':
    main()
