"""Frozen test, step 1: model_store.current_id / _point / promote (atomic current/previous symlinks)."""
import importlib
import os
import shutil
import socket
import sys
import tempfile


def _no_net(*_a, **_k):
    raise RuntimeError("network access in a unit test")


socket.socket.connect = _no_net  # any accidental download fails the test

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
ms = importlib.import_module("model_store")  # alias assigned ONLY here

ROOT = None


def setup():
    global ROOT
    ROOT = tempfile.mkdtemp(prefix="ms-s1-")


def make_staging(tag):
    st = os.path.join(ROOT, "staging")
    os.makedirs(os.path.join(st, "det"))
    with open(os.path.join(st, "det", "w.bin"), "w") as f:
        f.write(tag)
    return st


def read_current(name="current"):
    with open(os.path.join(ROOT, name, "det", "w.bin")) as f:
        return f.read()


def test_first_promote():
    setup()
    st = make_staging("one")
    dest = ms.promote(ROOT, st, "aaa111")
    assert dest == os.path.join(ROOT, "versions", "aaa111"), f"dest: {dest!r}"
    assert os.readlink(os.path.join(ROOT, "current")) == os.path.join("versions", "aaa111"), \
        f"current link: {os.readlink(os.path.join(ROOT, 'current'))!r}"
    assert ms.current_id(ROOT) == "aaa111", f"current_id: {ms.current_id(ROOT)!r}"
    assert not os.path.lexists(os.path.join(ROOT, "previous")), "previous must not exist after the first promote"
    assert not os.path.exists(st), "staging must be moved away"
    assert read_current() == "one", f"content: {read_current()!r}"


def test_second_promote_sets_previous():
    setup()
    ms.promote(ROOT, make_staging("one"), "aaa111")
    ms.promote(ROOT, make_staging("two"), "bbb222")
    assert ms.current_id(ROOT) == "bbb222", f"current_id: {ms.current_id(ROOT)!r}"
    assert ms.current_id(ROOT, "previous") == "aaa111", f"previous: {ms.current_id(ROOT, 'previous')!r}"
    assert os.readlink(os.path.join(ROOT, "previous")) == os.path.join("versions", "aaa111"), "previous must be relative"
    assert read_current() == "two" and read_current("previous") == "one", "link targets"
    left = sorted(n for n in os.listdir(ROOT) if n.endswith(".tmp"))
    assert left == [], f"temp links left behind: {left}"


def test_missing_links_and_relative_targets():
    setup()
    assert ms.current_id(ROOT) is None, "no current link -> None"
    assert ms.current_id(ROOT, "previous") is None, "no previous link -> None"
    ms.promote(ROOT, make_staging("one"), "aaa111")
    moved = ROOT + "-moved"
    shutil.move(ROOT, moved)
    with open(os.path.join(moved, "current", "det", "w.bin")) as f:
        got = f.read()
    assert got == "one", f"links must be relative so a moved root still resolves: {got!r}"
    assert ms.current_id(moved) == "aaa111", f"current_id after move: {ms.current_id(moved)!r}"


def test_promote_existing_version_refuses():
    setup()
    ms.promote(ROOT, make_staging("one"), "aaa111")
    st = make_staging("again")
    raised = False
    try:
        ms.promote(ROOT, st, "aaa111")
    except FileExistsError:
        raised = True
    assert raised, "promoting an id that is already installed must raise FileExistsError"
    assert os.path.isdir(st), "a refused promote must leave staging in place"
    assert read_current() == "one", f"current must be untouched: {read_current()!r}"
    assert not os.path.lexists(os.path.join(ROOT, "previous")), "a refused promote must not touch previous"


TESTS = [test_first_promote, test_second_promote_sets_previous, test_missing_links_and_relative_targets,
         test_promote_existing_version_refuses]

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
