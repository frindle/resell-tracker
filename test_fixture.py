"""Adversarial fixture for: bfmr-retry-window-cutover-bonsai

>>> THE ONE THING THE GENERATOR CANNOT WRITE FOR YOU <<<

CASES is empty and the verify FAILS until you fill it in. That is deliberate.
A generator can emit a verify that DISCRIMINATES (fails at baseline, passes on
a fix). It cannot decide whether the verify is RELEVANT -- whether it tests the
property the task actually asked for. A benign case passes broken work.

Pick inputs that separate "did the job" from "made the test go green":
  * the exact boundary the defect is about, and one on each side of it
  * the degenerate inputs (missing key, None, empty, wrong type) that must NOT
    raise
  * at least one case that a plausible WRONG fix would fail
  * the regression half: things that already work and must keep working

Each case: (description, callable_returning_actual, expected)
"""
import sys
import importlib.util
from importlib.machinery import SourceFileLoader

TARGET_PATH = 'app/api/bfmr/sync-reservations/route.ts'

# Load the route module as Python source. `spec_from_file_location` returns a
# spec with loader=None for .ts (no default file hook is registered), so fall
# back to an explicit SourceFileLoader -- the reference impl writes valid Python
# into the .ts file, and this is what makes it importable by the fixture.
spec = importlib.util.spec_from_file_location("target", TARGET_PATH)
if spec is None or spec.loader is None:
    loader = SourceFileLoader("target", TARGET_PATH)
    spec = importlib.util.spec_from_loader("target", loader)
target = importlib.util.module_from_spec(spec)
# REGISTER BEFORE EXEC. Not optional: a module loaded this way has no entry in
# sys.modules, so sys.modules[cls.__module__] is None -- and on Python 3.14 (the
# Studio worker) dataclasses resolves string annotations through exactly that
# lookup. A target with `from __future__ import annotations` + @dataclass then
# dies at IMPORT with AttributeError: 'NoneType' object has no attribute
# '__dict__', so the fixture fails for a reason that has nothing to do with
# the task and the dispatch reads as a model failure.
sys.modules["target"] = target
spec.loader.exec_module(target)

NOW = 1_000_000_000_000
WINDOW = target.RETRY_WINDOW_MS


def _key(uid, rid, oid):
    return target.split_attempt_key({"user_id": uid, "reserve_id": rid, "order_id": oid})


CASES = [
    # Core adversarial: reservation was NEVER split, but the user has a STALE
    # record under the WRONG (user-only) scope. Correct impl must NOT gate it;
    # a user-keyed (plausible wrong) fix would 409 here.
    ("never-split reservation with stale user-scoped record is not gated",
     lambda: target.sync_reservations(
         {"user_id": "alice", "reserve_id": "R1"},
         {"user:alice": NOW - 5 * 60 * 60 * 1000},
         NOW),
     {"status": 200, "reason": "synced"}),

    # Genuine repeat split attempt inside the window -> still gated (409).
    ("genuine repeat split attempt inside the 24h window is gated",
     lambda: target.sync_reservations(
         {"user_id": "alice", "reserve_id": "R1", "order_id": "ORD9"},
         {_key("alice", "R1", "ORD9"): NOW - 5 * 60 * 60 * 1000},
         NOW),
     {"status": 409, "reason": "retry_window"}),

    # Boundary: prior attempt exactly at the window edge -> NOT gated (elapsed).
    ("prior attempt exactly at the window boundary is not gated",
     lambda: target.sync_reservations(
         {"user_id": "alice", "reserve_id": "R1", "order_id": "ORD9"},
         {_key("alice", "R1", "ORD9"): NOW - WINDOW},
         NOW),
     {"status": 200, "reason": "synced"}),

    # Boundary: prior attempt one ms inside the window -> gated.
    ("prior attempt one millisecond inside the window is gated",
     lambda: target.sync_reservations(
         {"user_id": "alice", "reserve_id": "R1", "order_id": "ORD9"},
         {_key("alice", "R1", "ORD9"): NOW - (WINDOW - 1)},
         NOW),
     {"status": 409, "reason": "retry_window"}),

    # Scoping by order: an attempt for a DIFFERENT order of the same reserve
    # must not gate this reservation. Catches (user,reserve)-only keying.
    ("attempt for a different order of the same reserve is not gated",
     lambda: target.sync_reservations(
         {"user_id": "alice", "reserve_id": "R1", "order_id": "ORD9"},
         {_key("alice", "R1", "ORD8"): NOW - 5 * 60 * 60 * 1000},
         NOW),
     {"status": 200, "reason": "synced"}),

    # Degenerate: missing fields / None must not raise.
    ("missing order_id and reserve_id do not raise",
     lambda: target.sync_reservations({"user_id": "alice"}, {}, NOW),
     {"status": 200, "reason": "synced"}),

    # Regression: a split reservation retried AFTER the window elapses -> allowed.
    ("split reservation retried after the window elapses is allowed",
     lambda: target.sync_reservations(
         {"user_id": "alice", "reserve_id": "R1", "order_id": "ORD9"},
         {_key("alice", "R1", "ORD9"): NOW - (WINDOW + 60 * 1000)},
         NOW),
     {"status": 200, "reason": "synced"}),

    # Degenerate: empty attempt ledger -> not gated.
    ("empty attempt ledger does not gate",
     lambda: target.sync_reservations(
         {"user_id": "alice", "reserve_id": "R1", "order_id": "ORD9"},
         {},
         NOW),
     {"status": 200, "reason": "synced"}),

    # Pin the exact key format (user|reserve|order) so wrong separators fail.
    ("split_attempt_key scopes on user+reserve+order",
     lambda: target.split_attempt_key(
         {"user_id": "alice", "reserve_id": "R1", "order_id": "ORD9"}),
     "alice|R1|ORD9"),

    # Degenerate: missing now_ms must not raise or gate (no reference clock).
    ("missing now_ms does not raise or gate",
     lambda: target.sync_reservations(
         {"user_id": "alice", "reserve_id": "R1", "order_id": "ORD9"},
         {_key("alice", "R1", "ORD9"): NOW - 5 * 60 * 60 * 1000},
         None),
     {"status": 200, "reason": "synced"}),

    # Degenerate: missing attempt ledger must not raise or gate.
    ("missing attempt ledger does not raise or gate",
     lambda: target.sync_reservations(
         {"user_id": "alice", "reserve_id": "R1", "order_id": "ORD9"},
         None,
         NOW),
     {"status": 200, "reason": "synced"}),
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
