"""Frozen test, step 1: model_update.next_run (next local midnight, DST-safe)."""
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

LA = "America/Los_Angeles"


def utc(*a):
    return datetime(*a, tzinfo=timezone.utc)


def test_midnight_is_local_not_utc():
    # 2026-10-20 15:00 UTC = 08:00 PDT. Next LA midnight = 2026-10-21 00:00 PDT = 07:00 UTC.
    got = mu.next_run(utc(2026, 10, 20, 15, 0), LA)
    assert got == utc(2026, 10, 21, 7, 0), f"next LA midnight, got {got!r}"
    assert got.utcoffset() is not None and got.astimezone(timezone.utc).hour == 7, "aware result"


def test_dst_end_2026_11_01():
    # 00:30 PDT on the fall-back day (07:30 UTC). Next midnight is 2026-11-02 00:00 PST = 08:00 UTC.
    got = mu.next_run(utc(2026, 11, 1, 7, 30), LA)
    assert got == utc(2026, 11, 2, 8, 0), f"after fall-back the target is 08:00 UTC, got {got!r}"
    # 23:30 PDT the night before (06:30 UTC) -> 2026-11-01 00:00 PDT = 07:00 UTC.
    got = mu.next_run(utc(2026, 11, 1, 6, 30), LA)
    assert got == utc(2026, 11, 1, 7, 0), f"the evening before fall-back, got {got!r}"


def test_dst_start_2027_03_14_and_hour():
    # 2027-03-14 01:00 PST (09:00 UTC), spring forward at 02:00. Next midnight 2027-03-15 00:00 PDT = 07:00 UTC.
    got = mu.next_run(utc(2027, 3, 14, 9, 0), LA)
    assert got == utc(2027, 3, 15, 7, 0), f"after spring-forward the target is 07:00 UTC, got {got!r}"
    # hour=3 on the same morning: 03:00 PDT the same day = 10:00 UTC.
    got = mu.next_run(utc(2027, 3, 14, 9, 0), LA, hour=3)
    assert got == utc(2027, 3, 14, 10, 0), f"hour=3 later the same day, got {got!r}"


def test_exactly_at_target_moves_to_next_day_and_jitter():
    # Exactly 00:00 PDT is not "after now": the next run is the following midnight.
    got = mu.next_run(utc(2026, 10, 21, 7, 0), LA)
    assert got == utc(2026, 10, 22, 7, 0), f"strictly after now, got {got!r}"
    got = mu.next_run(utc(2026, 10, 20, 15, 0), LA, jitter_s=125)
    assert got == utc(2026, 10, 21, 7, 2, 5), f"jitter adds seconds, got {got!r}"


TESTS = [test_midnight_is_local_not_utc, test_dst_end_2026_11_01,
         test_dst_start_2027_03_14_and_hour, test_exactly_at_target_moves_to_next_day_and_jitter]

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
