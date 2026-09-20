"""Adversarial fixture for: bfmr-retry-window-cutover-v2

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

# The target has a .ts extension, so spec_from_file_location cannot infer a
# loader from the suffix -- pass an explicit SourceFileLoader.
loader = SourceFileLoader("target", 'app/api/bfmr/sync-reservations/route.ts')
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


class FakeRequest:
    """Minimal Request surface: .headers dict + .json()."""

    def __init__(self, headers=None, payload="__INVALID__", raise_on_json=False):
        self.headers = headers or {}
        self._payload = payload
        self._raise = raise_on_json

    def json(self):
        if self._raise:
            raise ValueError("body is not valid JSON")
        return self._payload


def _reset():
    target._prior_attempts.clear()


def _call(headers, body=None, bad_json=False):
    req = FakeRequest(headers=headers, payload=body, raise_on_json=bad_json)
    status, resp = target.POST(req)
    return (status, resp)


def _repeat(first_body, second_body, first_headers=None, second_headers=None):
    """Reset state, make the first attempt, then return the SECOND call's result."""
    _reset()
    _call(first_headers or AUTH, first_body)
    return _call(second_headers or AUTH, second_body)


AUTH = {"x-user-id": "user-1"}

CASES = [
    # --- auth / input validation: right 4xx, not a 500 --------------------
    ("missing x-user-id -> 401 with error body",
     lambda: _reset() or _call({}, {"reserve_id": "R1", "order_id": "O1"}),
     (401, {"error": "not authenticated"})),

    ("invalid JSON body -> 400, not a crash",
     lambda: _reset() or _call(AUTH, bad_json=True),
     (400, {"error": "invalid JSON body"})),

    ("missing reserve_id/order_id -> 400 naming the required fields",
     lambda: _reset() or _call(AUTH, {"reserve_id": "R1"}),
     (400, {"error": "missing required fields: reserve_id, order_id"})),

    # --- happy path: first genuine attempt syncs ---------------------------
    ("first split attempt -> 200 synced with correct scopeKey",
     lambda: _reset() or _call(AUTH, {"reserve_id": "R1", "order_id": "O1", "now_ms": 1_000_000}),
     (200, {
         "synced": True,
         "splitAttempted": True,
         "scopeKey": {"user_id": "user-1", "reserve_id": "R1", "order_id": "O1"},
         "retryWindowMs": 86_400_000,
     })),

    # --- the defect: repeat attempt within window IS gated ----------------
    ("repeat same user+reserve+order inside 24h -> 409 retry window active",
     lambda: _repeat({"reserve_id": "R1", "order_id": "O1", "now_ms": 1_000_000},
                     {"reserve_id": "R1", "order_id": "O1", "now_ms": 1_000_000 + 3_600_000}),
     (409, {
         "error": "retry window active",
         "scopeKey": {"user_id": "user-1", "reserve_id": "R1", "order_id": "O1"},
         "retryWindowMs": 86_400_000,
     })),

    # --- THE core defect: stale record under a DIFFERENT scope must NOT gate
    ("stale prior attempt on same reserve but different order -> 200 (not gated)",
     lambda: _repeat({"reserve_id": "R9", "order_id": "OLD-ORDER", "now_ms": 5_000_000},
                     {"reserve_id": "R9", "order_id": "NEW-ORDER", "now_ms": 5_100_000}),
     (200, {
         "synced": True,
         "splitAttempted": True,
         "scopeKey": {"user_id": "user-1", "reserve_id": "R9", "order_id": "NEW-ORDER"},
         "retryWindowMs": 86_400_000,
     })),

    ("stale prior attempt by a DIFFERENT user on same reserve+order -> 200 (not gated)",
     lambda: _repeat({"reserve_id": "R7", "order_id": "O7", "now_ms": 5_000_000},
                     {"reserve_id": "R7", "order_id": "O7", "now_ms": 5_100_000},
                     first_headers={"x-user-id": "user-2"}),
     (200, {
         "synced": True,
         "splitAttempted": True,
         "scopeKey": {"user_id": "user-1", "reserve_id": "R7", "order_id": "O7"},
         "retryWindowMs": 86_400_000,
     })),

    # --- boundary: exactly at the window edge the gate lifts ---------------
    ("repeat at exactly RETRY_WINDOW_MS elapsed -> allowed (200)",
     lambda: _repeat({"reserve_id": "R5", "order_id": "O5", "now_ms": 1_000_000},
                     {"reserve_id": "R5", "order_id": "O5", "now_ms": 1_000_000 + target.RETRY_WINDOW_MS}),
     (200, {
         "synced": True,
         "splitAttempted": True,
         "scopeKey": {"user_id": "user-1", "reserve_id": "R5", "order_id": "O5"},
         "retryWindowMs": 86_400_000,
     })),

    ("repeat one ms before the window edge -> still gated (409)",
     lambda: _repeat({"reserve_id": "R6", "order_id": "O6", "now_ms": 1_000_000},
                     {"reserve_id": "R6", "order_id": "O6", "now_ms": 1_000_000 + target.RETRY_WINDOW_MS - 1}),
     (409, {
         "error": "retry window active",
         "scopeKey": {"user_id": "user-1", "reserve_id": "R6", "order_id": "O6"},
         "retryWindowMs": 86_400_000,
     })),
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
