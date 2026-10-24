"""Frozen test, step 3: model_store.file_hashes / version_id / find_corrupt."""
import hashlib
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


def tree(files):
    d = tempfile.mkdtemp(prefix="ms-s3-")
    for rel, body in files.items():
        p = os.path.join(d, *rel.split("/"))
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "wb") as f:
            f.write(body)
    return d


def sha(b):
    return hashlib.sha256(b).hexdigest()


FILES = {"PP-OCRv6_medium_det/inference.pdiparams": b"weights-det", "PP-OCRv6_medium_rec/inference.yml": b"cfg: 1\n"}


def test_file_hashes_relative_posix():
    d = tree(FILES)
    got = ms.file_hashes(d)
    want = {rel: sha(body) for rel, body in FILES.items()}
    assert got == want, f"file_hashes: {got!r}"
    assert ms.file_hashes(tree({})) == {}, "empty dir -> {}"


def test_version_id_stable_and_content_sensitive():
    a, b = tree(FILES), tree(FILES)
    va = ms.version_id(a)
    assert isinstance(va, str) and len(va) == 12 and all(c in "0123456789abcdef" for c in va), f"12 hex chars: {va!r}"
    assert ms.version_id(b) == va, "same files in another dir -> same id"
    h = hashlib.sha256()
    for rel in sorted(FILES):
        h.update(f"{rel}\0{sha(FILES[rel])}\n".encode())
    assert va == h.hexdigest()[:12], f"id must be sha256 over sorted 'rel\\0hash\\n' lines: {va!r}"
    changed = tree({**FILES, "PP-OCRv6_medium_rec/inference.yml": b"cfg: 2\n"})
    assert ms.version_id(changed) != va, "changed content -> different id"
    renamed = tree({"x/inference.pdiparams": b"weights-det", "PP-OCRv6_medium_rec/inference.yml": b"cfg: 1\n"})
    assert ms.version_id(renamed) != va, "renamed file -> different id"


def test_find_corrupt():
    d = tree(FILES)
    expected = {rel: sha(body) for rel, body in FILES.items()}
    assert ms.find_corrupt(d, expected) == [], "intact tree -> []"
    with open(os.path.join(d, "PP-OCRv6_medium_rec", "inference.yml"), "wb") as f:
        f.write(b"garbage")
    os.unlink(os.path.join(d, "PP-OCRv6_medium_det", "inference.pdiparams"))
    got = ms.find_corrupt(d, expected)
    assert got == ["PP-OCRv6_medium_det/inference.pdiparams", "PP-OCRv6_medium_rec/inference.yml"], f"corrupt: {got!r}"


TESTS = [test_file_hashes_relative_posix, test_version_id_stable_and_content_sensitive, test_find_corrupt]

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
