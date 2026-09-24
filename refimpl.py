#!/usr/bin/env python3
"""Reference impl for: rt-bfmr-sync-scope-wiring

The gate applies this, runs the verify, and reverts it. It proves two things at
once: the task is SATISFIABLE as specified, and the verify actually ENFORCES
the spec (a refimpl that goes green while a "Must contain" literal is absent
means the verify is benign).

Writes lib/bfmrSyncTrigger.ts (the decision module) and applies the structural
wiring edits the pins force: route.ts calls resolveBfmrSyncPlan, the linker's
auto-sync fetch carries the 'order-open' trigger, autoSync's loopback POST
carries the 'scheduled' trigger. Also drops a minimal lib/bfmrSyncScope.ts
placeholder (real body lands in the sibling dispatch) so the route import
resolves and tsc stays clean. Idempotent: each step is skipped if its target
content is already present.
"""
import pathlib
import sys

wt = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")


def _write(path: pathlib.Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)


# --- lib/bfmrSyncTrigger.ts (the decision module -- always the full body) ----
TRIGGER_TS = r'''// Decides WHICH sync scope each caller of POST /api/bfmr/sync-reservations is
// entitled to. Pure: no DB, no network, no clock, and deliberately NO import
// from the concurrently-authored scope-plan module (sibling dispatch) -- the
// scope names are plain literals declared here so this module stands alone.

export type BfmrSyncTrigger = 'order-open' | 'manual' | 'scheduled';

export type BfmrSyncScopeName = 'pending' | 'full';

// The frozen trigger->scope policy. Object.freeze is load-bearing: a caller
// that mutates the mapping would silently re-point a trigger (e.g. narrowing
// the scheduled sync so the myTrackerId web backfill never runs again).
export const SYNC_TRIGGER_SCOPES: Readonly<Record<BfmrSyncTrigger, BfmrSyncScopeName>> = Object.freeze({
  'order-open': 'pending', // the narrow, cheap pull -- ONLY this trigger gets it
  manual: 'full',          // full status enum + web backfill must keep running
  scheduled: 'full',       // same: the background sync is where the backfill converges
});

// Fail-safe direction: an unknown trigger must never silently NARROW a sync.
// Total and non-throwing -- undefined, null, '', case variants, numbers and
// objects all fall through to 'full'.
export function scopeForSyncTrigger(trigger: BfmrSyncTrigger): BfmrSyncScopeName {
  if (trigger === 'order-open') return SYNC_TRIGGER_SCOPES['order-open'];
  return 'full';
}
'''

# --- lib/bfmrSyncScope.ts (minimal placeholder; sibling dispatch owns the body)
SCOPE_TS = r'''// PLACEHOLDER for the sibling dispatch that authors this module's real body.
// Supplies just enough surface for app/api/bfmr/sync-reservations/route.ts to
// resolve its import and type-check: a scope name -> tracker filter + whether
// the myTrackerId web backfill runs on that pass.

export type BfmrSyncScopeName = 'pending' | 'full';

export interface BfmrSyncPlan {
  filters: Array<{ status?: string; page_size?: number }>;
  runWebBackfill: boolean;
}

const FULL_STATUS_ENUM = 'purchased,reserved,return,payment_error,shipped,processed,set_aside,paid,cancelled,returned,closed,deadline,pkg_received';

export function resolveBfmrSyncPlan(scope: BfmrSyncScopeName): BfmrSyncPlan {
  if (scope === 'pending') {
    return { filters: [{ status: 'reserved', page_size: 200 }], runWebBackfill: false };
  }
  return { filters: [{ status: FULL_STATUS_ENUM, page_size: 200 }], runWebBackfill: true };
}
'''

# --- route.ts wiring ----------------------------------------------------------
ROUTE_OLD = """import { getMyTracker, getMyTrackerAll, deriveBfmrStatus, type TrackerFilter } from '@/lib/bfmr';"""
ROUTE_NEW = """import { getMyTrackerAll, deriveBfmrStatus, type TrackerFilter } from '@/lib/bfmr';
import { resolveBfmrSyncPlan } from '@/lib/bfmrSyncScope';"""

# The trigger arrives on the request body (linker sends 'order-open', autoSync
# sends 'scheduled'); absent/unknown -> scopeForSyncTrigger fails safe to full.
ROUTE_FILTERS_OLD = """  const filters: TrackerFilter[] = [
    {
      status: 'purchased,reserved,return,payment_error,shipped,processed,set_aside,paid,cancelled,returned,closed,deadline,pkg_received',
      page_size: 200,
    },
  ];"""
ROUTE_FILTERS_NEW = """  // Scope decision lives in lib/bfmrSyncTrigger.ts (pure): 'order-open' is the
  // only trigger entitled to the narrow pull; manual/scheduled/unknown keep
  // the full status enum so the myTrackerId web backfill still converges.
  const body = await req.json().catch(() => ({}));
  const scope = scopeForSyncTrigger((body as { trigger?: BfmrSyncTrigger }).trigger);
  const plan = resolveBfmrSyncPlan(scope);
  const filters: TrackerFilter[] = plan.filters;"""

ROUTE_IMPORT_OLD = """import { reservationLineKey } from '@/lib/bfmrReservationLineKey';"""
ROUTE_IMPORT_NEW = """import { reservationLineKey } from '@/lib/bfmrReservationLineKey';
import { scopeForSyncTrigger, type BfmrSyncTrigger } from '@/lib/bfmrSyncTrigger';"""

# --- linker wiring -------------------------------------------------------------
LINKER_FETCH_OLD = """        fetch('/api/bfmr/sync-reservations', { method: 'POST' })
          .then(() => load())"""
LINKER_FETCH_NEW = """        // The order-open path is the ONLY caller entitled to the narrow scope;
        // the route maps it via scopeForSyncTrigger('order-open') -> 'pending'.
        fetch('/api/bfmr/sync-reservations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ trigger: 'order-open' }),
        })
          .then(() => load())"""

# --- autoSync wiring -----------------------------------------------------------
AUTOSYNC_OLD = """await loopbackPost('/api/bfmr/sync-reservations', u.uid).catch(e =>"""
AUTOSYNC_NEW = """await loopbackPost('/api/bfmr/sync-reservations', u.uid, { trigger: 'scheduled' }).catch(e =>"""


def _patch(path: pathlib.Path, old: str, new: str, marker: str) -> None:
    t = path.read_text()
    if marker in t and old not in t:
        print(f"  skip (already wired): {path}")
        return
    assert old in t, f"refimpl anchor not found in {path} -- did the file change?"
    path.write_text(t.replace(old, new, 1))
    print(f"  patched: {path}")


def main() -> None:
    _write(wt / 'lib' / 'bfmrSyncTrigger.ts', TRIGGER_TS)
    print("  wrote lib/bfmrSyncTrigger.ts")

    scope_p = wt / 'lib' / 'bfmrSyncScope.ts'
    if not scope_p.is_file():
        _write(scope_p, SCOPE_TS)
        print("  wrote lib/bfmrSyncScope.ts (placeholder)")

    route = wt / 'app' / 'api' / 'bfmr' / 'sync-reservations' / 'route.ts'
    if "resolveBfmrSyncPlan" not in route.read_text():
        _patch(route, ROUTE_IMPORT_OLD, ROUTE_IMPORT_NEW, "scopeForSyncTrigger")
        _patch(route, ROUTE_FILTERS_OLD, ROUTE_FILTERS_NEW, "resolveBfmrSyncPlan")
    else:
        print("  skip (already wired): route.ts")

    linker = wt / 'components' / 'BfmrReservationLinker.tsx'
    if "'order-open'" not in linker.read_text():
        _patch(linker, LINKER_FETCH_OLD, LINKER_FETCH_NEW, "trigger: 'order-open'")
    else:
        print("  skip (already wired): BfmrReservationLinker.tsx")

    autosync = wt / 'lib' / 'autoSync.ts'
    if "'scheduled'" not in autosync.read_text():
        _patch(autosync, AUTOSYNC_OLD, AUTOSYNC_NEW, "trigger: 'scheduled'")
    else:
        print("  skip (already wired): autoSync.ts")

    print("refimpl applied")


if __name__ == '__main__':
    main()
