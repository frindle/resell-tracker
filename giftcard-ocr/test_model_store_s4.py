"""Frozen test, step 4: model_store.try_lock (one updater run at a time)."""
import importlib
import os
import socket
import sys
import tempfile


def _no_net(*_a, **_k):
    raise RuntimeError("network access in a unit test")


socket.socket.connect = _no_net

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
ms = importlib.import_module("model_store")  # alias assigned ONLY here


def test_second_lock_is_busy_until_release():
    root = tempfile.mkdtemp(prefix="ms-s4-")
    first = ms.try_lock(root)
    assert first is not None, "first try_lock must succeed"
    assert os.path.isfile(os.path.join(root, ".lock")), "lock file is root/.lock"
    second = ms.try_lock(root)
    assert second is None, f"second try_lock while held must return None: {second!r}"
    first.close()
    third = ms.try_lock(root)
    assert third is not None, "after the holder closes, try_lock succeeds again"
    third.close()


def test_lock_creates_missing_root():
    root = os.path.join(tempfile.mkdtemp(prefix="ms-s4-"), "not", "yet")
    held = ms.try_lock(root)
    assert held is not None, "try_lock must create a missing root"
    assert os.path.isdir(root), "root created"
    held.close()


TESTS = [test_second_lock_is_busy_until_release, test_lock_creates_missing_root]

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
