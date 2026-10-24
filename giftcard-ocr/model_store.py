"""On-disk store for downloaded OCR model versions. Pure stdlib: never imports paddle.

Layout under the store root (env OCR_MODEL_ROOT, default /data/ocr-models):

  current -> versions/<id>    relative symlink, replaced atomically
  previous -> versions/<id>   the last good version, kept for fallback
  versions/<id>/...           one installed version; <id> = version_id() of its files
  staging/                    downloads land here before promote()
  .lock                       flock held by the one updater run allowed at a time
"""

from __future__ import annotations

import fcntl
import hashlib
import os
import shutil

DEFAULT_ROOT = "/data/ocr-models"


def root_dir() -> str:
    return os.environ.get("OCR_MODEL_ROOT") or DEFAULT_ROOT


def current_id(root, name="current"):
    """Id of the version root/<name> points at (the link target's basename), or None when the link is missing."""
    link = os.path.join(root, name)
    if not os.path.islink(link):
        return None
    target = os.readlink(link).rstrip("/")
    return os.path.basename(target)


def _point(root, name, vid):
    """Atomically make root/<name> a RELATIVE symlink to versions/<vid>: temp link, then os.replace."""
    link_path = os.path.join(root, name)
    tmp_path = os.path.join(root, f".{name}.tmp")
    target = os.path.join("versions", vid)
    try:
        os.unlink(tmp_path)
    except FileNotFoundError:
        pass
    os.symlink(target, tmp_path)
    os.replace(tmp_path, link_path)


def promote(root, staging, vid):
    """Move the staging dir to versions/<vid>, point previous at the old current, then current at vid."""
    dest = os.path.join(root, "versions", vid)
    if os.path.exists(dest) or os.path.islink(dest):
        raise FileExistsError(f"version {vid} already exists")
    os.makedirs(os.path.join(root, "versions"), exist_ok=True)
    shutil.move(staging, dest)
    old = current_id(root)
    if old is not None and old != vid:
        _point(root, "previous", old)
    _point(root, "current", vid)
    return dest


def prune(root):
    """Delete every versions/<id> except the ones current and previous point at. Returns the removed ids, sorted."""
    versions_dir = os.path.join(root, "versions")
    if not os.path.isdir(versions_dir):
        return []
    keep = {current_id(root), current_id(root, "previous")}
    keep.discard(None)
    removed = []
    for vid in os.listdir(versions_dir):
        if vid not in keep:
            shutil.rmtree(os.path.join(versions_dir, vid))
            removed.append(vid)
    return sorted(removed)



def file_hashes(path):
    """{relative posix path: sha256 hex} for every regular file under path."""
    result = {}
    for dirpath, _dirnames, filenames in os.walk(path):
        for fname in filenames:
            full = os.path.join(dirpath, fname)
            if not os.path.isfile(full):
                continue
            rel = os.path.relpath(full, path).replace(os.sep, "/")
            h = hashlib.sha256()
            with open(full, "rb") as f:
                h.update(f.read())
            result[rel] = h.hexdigest()
    return result


def version_id(path):
    """First 12 hex chars of a sha256 over the sorted (relative path, file hash) pairs under path."""
    h = hashlib.sha256()
    for rel, digest in sorted(file_hashes(path).items()):
        h.update(f"{rel}\0{digest}\n".encode())
    return h.hexdigest()[:12]


def find_corrupt(path, expected):
    """Sorted relative paths from expected ({rel: sha256}) whose file under path is missing or hashes differently."""
    have = file_hashes(path)
    return sorted(r for r in expected if have.get(r) != expected[r])


def try_lock(root):
    """Take an exclusive non-blocking flock on root/.lock. Returns the open file (keep it to hold the lock) or None if busy."""
    os.makedirs(root, exist_ok=True)
    path = os.path.join(root, ".lock")
    f = open(path, "a")
    try:
        fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        f.close()
        return None
    return f
