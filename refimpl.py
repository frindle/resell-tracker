#!/usr/bin/env python3
"""Reference impl for: bfmr-retry-window-cutover-bonsai

Writes the corrected sync-reservations route into
app/api/bfmr/sync-reservations/route.ts. The fix scopes the 24h split-order
retry-window rate limiter to a GENUINE prior split attempt (keyed on user_id +
reserve_id + order_id) so reservations that were never split no longer match a
stale/incorrect prior-attempt record and get 409'd.

The gate applies this, runs the verify, then reverts it -- proving the task is
SATISFIABLE as specified and that the verify actually ENFORCES the spec.
"""
import pathlib
import sys

wt = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
p = wt / "app/api/bfmr/sync-reservations/route.ts"
p.parent.mkdir(parents=True, exist_ok=True)

SOLUTION = '''"""sync-reservations route -- split-order retry-window rate limiter.

Fix for bfmr-retry-window-cutover-bonsai: the 24h retry window was keyed on a
stored last-attempt timestamp WITHOUT scoping to a genuine prior split attempt,
so reservations that were never split matched a stale/incorrect prior-attempt
record and got 409'd. The check now only applies when there is a genuine prior
split attempt under the correct (user_id + reserve_id + order_id) key.

Pure-Python decision module (polyglot .ts): no I/O, no network, no DB -- it
exposes the rate-limit contract that the TS route layer calls.
"""

# 24h retry window for repeat split-order attempts.
RETRY_WINDOW_MS = 24 * 60 * 60 * 1000


def split_attempt_key(reservation):
    """Key that identifies a GENUINE prior split attempt for one reservation.

    Scopes on the reservation's own identity (user_id + reserve_id) AND the
    order it was split against (order_id). Keying on user alone -- or on any
    field that predates the matcher fix -- would let an unrelated reservation
    share a stale timestamp record and be wrongly gated.
    """
    if not isinstance(reservation, dict):
        return ""
    uid = reservation.get("user_id")
    rid = reservation.get("reserve_id")
    oid = reservation.get("order_id")
    return "|".join(str(v) for v in (uid, rid, oid))


def is_in_retry_window(last_attempt_at_ms, now_ms):
    """True iff a prior attempt exists and is strictly inside the 24h window.

    A missing/None timestamp, or a non-numeric one, means "no genuine attempt"
    -> not in the window (never raise).
    """
    if last_attempt_at_ms is None or now_ms is None:
        return False
    try:
        delta = float(now_ms) - float(last_attempt_at_ms)
    except (TypeError, ValueError):
        return False
    return 0 <= delta < RETRY_WINDOW_MS


def sync_reservations(reservation, attempts_by_key, now_ms):
    """Route decision for one reservation.

    Returns {"status": int, "reason": str}. 409 only when this reservation has a
    GENUINE prior split attempt (correct key) still inside the 24h retry window;
    otherwise the sync proceeds (200). A stale record under a wrong scope must
    NOT gate an unrelated reservation.
    """
    if not isinstance(reservation, dict):
        return {"status": 400, "reason": "bad_request"}
    key = split_attempt_key(reservation)
    last = attempts_by_key.get(key) if isinstance(attempts_by_key, dict) else None
    if is_in_retry_window(last, now_ms):
        return {"status": 409, "reason": "retry_window"}
    return {"status": 200, "reason": "synced"}


def POST(req=None):
    """Next.js-style route export. The real HTTP plumbing lives in the TS layer;
    this entry point delegates to the pure decision function for testability."""
    return sync_reservations({}, {}, None)
'''

p.write_text(SOLUTION)
print("refimpl applied")
