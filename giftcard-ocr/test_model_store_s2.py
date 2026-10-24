"""Frozen test, step 2: model_store.prune keeps exactly the current and previous versions."""
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

ROOT = None


def setup():
    global ROOT
    ROOT = tempfile.mkdtemp(prefix="ms-s2-")


def install(vid):
    st = os.path.join(ROOT, "staging")
    os.makedirs(st)
    with open(os.path.join(st, "w.bin"), "w") as f:
        f.write(vid)
    ms.promote(ROOT, st, vid)


def versions():
    return sorted(os.listdir(os.path.join(ROOT, "versions")))


def test_prune_keeps_current_and_previous():
    setup()
    for vid in ("v1", "v2", "v3", "v4"):
        install(vid)
    removed = ms.prune(ROOT)
    assert removed == ["v1", "v2"], f"removed: {removed!r}"
    assert versions() == ["v3", "v4"], f"left: {versions()!r}"
    assert ms.current_id(ROOT) == "v4" and ms.current_id(ROOT, "previous") == "v3", "links untouched"
    again = ms.prune(ROOT)
    assert again == [], f"second prune removes nothing: {again!r}"


def test_prune_without_previous_keeps_only_current():
    setup()
    install("v1")
    os.makedirs(os.path.join(ROOT, "versions", "orphan", "det"))
    removed = ms.prune(ROOT)
    assert removed == ["orphan"], f"removed: {removed!r}"
    assert versions() == ["v1"], f"left: {versions()!r}"


def test_prune_empty_root():
    setup()
    removed = ms.prune(ROOT)
    assert removed == [], f"no versions dir -> []: {removed!r}"
    assert not os.path.exists(os.path.join(ROOT, "versions")), "prune must not create versions/"


TESTS = [test_prune_keeps_current_and_previous, test_prune_without_previous_keeps_only_current, test_prune_empty_root]

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
