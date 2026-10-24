"""Frozen test, step 2: model_update.catchup_due (26h boot catch-up rule)."""
import importlib
import os
import socket
import sys
from datetime import datetime, timezone


def _no_net(*_a, **_k):
    raise RuntimeError("network access in a unit test")


socket.socket.connect = _no_net

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
mu = importlib.import_module("model_update")  # alias assigned ONLY here

NOW = datetime(2026, 10, 24, 12, 0, tzinfo=timezone.utc)


def test_missing_or_bad_last_check_is_due():
    assert mu.catchup_due({}, NOW) is True, "no last_check -> due"
    assert mu.catchup_due({"last_check": None}, NOW) is True, "None -> due"
    assert mu.catchup_due({"last_check": "yesterday"}, NOW) is True, "unparseable -> due"
    assert mu.catchup_due({"last_check": "2026-10-24T11:00:00"}, NOW) is True, "naive timestamp -> due"


def test_age_threshold_26h():
    fresh = {"last_check": "2026-10-23T10:01:00+00:00"}  # 25h59m old
    assert mu.catchup_due(fresh, NOW) is False, "under 26h -> not due"
    old = {"last_check": "2026-10-23T10:00:00+00:00"}  # exactly 26h
    assert mu.catchup_due(old, NOW) is True, "26h or older -> due"
    # Offsets are respected: 03:30 PDT = 10:30 UTC the day before, 25.5h old.
    la = {"last_check": "2026-10-23T03:30:00-07:00"}
    assert mu.catchup_due(la, NOW) is False, "offset-aware comparison"


def test_custom_max_age():
    s = {"last_check": "2026-10-24T09:00:00+00:00"}  # 3h old
    assert mu.catchup_due(s, NOW, max_age_h=2) is True, "max_age_h=2 -> due"
    assert mu.catchup_due(s, NOW, max_age_h=4) is False, "max_age_h=4 -> not due"


TESTS = [test_missing_or_bad_last_check_is_due, test_age_threshold_26h, test_custom_max_age]

if __name__ == "__main__":
    order = TESTS[::-1] if os.environ.get("TEST_ORDER") == "reverse" else TESTS
    failed = 0
    for t in order:
        try:
            t()
            print(f"RESULT {t.__name__} PASS")
        except Exception as e:
            failed += 1
            print(f"RESULT {t.__name__} FAIL {type(e).__name__}: {e}")
    print(f"{len(order) - failed} passed, {failed} failed")
    sys.exit(1 if failed else 0)
