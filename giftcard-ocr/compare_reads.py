"""Proof that the faster scheduling reads exactly what the old one did.

    python compare_reads.py DIR [--rotations 0,180]

Reads every image in DIR twice: once the way the service used to (one engine,
one thread, variants one after another) and once the way it does now (a pool of
engines with several threads each, variants in parallel). Prints ONLY counts
and timings, never a code, text or file name. Exit code 1 if any result
differs, or any read failed.

Each mode runs in its own process because the thread count is fixed when the
paddle libraries load. Results travel between the processes through a temp
file and are only ever compared, never printed.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time

IMAGE_EXT = (".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp")


def _turned(op: str) -> list[str]:
    # Same variant lists lib/photoOcrRun.ts asks for.
    return [f"{op}+redchan+stretch14", f"{op}+grayscale"]


TURNS = {0: None, 90: _turned("rot90cw"), 180: _turned("rot180"), 270: _turned("rot90ccw")}


def canonical(result: dict) -> str:
    """The result with timings removed, as a stable string."""
    r = dict(result)
    r.pop("elapsed_s", None)
    r["variants"] = [{k: v for k, v in e.items() if k != "elapsed_s"} for e in result.get("variants", [])]
    return json.dumps(r, sort_keys=True)


def list_images(directory: str) -> list[str]:
    names = sorted(n for n in os.listdir(directory) if n.lower().endswith(IMAGE_EXT))
    return [os.path.join(directory, n) for n in names]


def worker(mode: str, directory: str, rotations: list[int], out_path: str) -> int:
    """Read every image in one mode; write canonical results and seconds to out_path."""
    # The environment was set by the parent (see mode_env) before this
    # interpreter started, so numpy and paddle saw it at import.
    import engine as engine_mod  # noqa: E402

    if mode == "old":
        # As shipped: no cpu_threads argument, OMP/MKL at 1.
        reader = engine_mod.Engine(cpu_threads=None)
    else:
        reader = engine_mod.EnginePool(size=engine_mod.POOL_SIZE, cpu_threads=engine_mod.THREADS)
    reader.load()  # model build is not part of the timing

    results = []
    seconds = 0.0
    for path in list_images(directory):
        with open(path, "rb") as f:
            data = f.read()
        per_rotation = []
        t0 = time.time()
        for rot in rotations:
            try:
                per_rotation.append(canonical(reader.read(data, variant_names=TURNS[rot])))
            except Exception as exc:  # noqa: BLE001 - counted, never shown
                per_rotation.append("error:" + type(exc).__name__)
        seconds += time.time() - t0
        results.append(per_rotation)
    with open(out_path, "w") as f:
        json.dump({"results": results, "seconds": seconds}, f)
    return 0


def mode_env(mode: str) -> dict:
    """Environment for the child process of one mode."""
    env = dict(os.environ)
    env["FLAGS_use_mkldnn"] = "0"
    if mode == "old":
        # What the shipped image set: one OMP/MKL thread, one engine.
        env["OCR_THREADS"] = "1"
        env["OCR_POOL_SIZE"] = "1"
        env["OMP_NUM_THREADS"] = "1"
        env["MKL_NUM_THREADS"] = "1"
    else:
        # engine.py derives OMP/MKL from OCR_THREADS; drop inherited values.
        env.pop("OMP_NUM_THREADS", None)
        env.pop("MKL_NUM_THREADS", None)
    return env


def run_mode(mode: str, directory: str, rotations: list[int], tmp: str) -> dict | None:
    out = os.path.join(tmp, f"{mode}.json")
    cmd = [sys.executable, os.path.abspath(__file__), "--worker", mode, directory,
           "--rotations", ",".join(str(r) for r in rotations), "--out", out]
    proc = subprocess.run(cmd, env=mode_env(mode), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if proc.returncode != 0 or not os.path.exists(out):
        return None
    with open(out) as f:
        return json.load(f)


def compare(old: dict, new: dict) -> tuple[int, int, int]:
    """(images, identical, differing). An image is identical only if every
    rotation matches and none of them errored."""
    images = identical = 0
    for a, b in zip(old["results"], new["results"]):
        images += 1
        same = a == b and not any(x.startswith("error:") for x in a + b)
        identical += 1 if same else 0
    return images, identical, images - identical


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("directory")
    ap.add_argument("--rotations", default="0,180", help="comma list of 0/90/180/270 (default: the two the app reads)")
    ap.add_argument("--worker", choices=("old", "new"), help=argparse.SUPPRESS)
    ap.add_argument("--out", help=argparse.SUPPRESS)
    args = ap.parse_args(argv)
    rotations = [int(r) for r in args.rotations.split(",") if r.strip()]
    if not rotations or any(r not in TURNS for r in rotations):
        print("rotations must be from 0,90,180,270")
        return 2

    if args.worker:
        return worker(args.worker, args.directory, rotations, args.out)

    n = len(list_images(args.directory))
    if n == 0:
        print("images: 0")
        return 2
    with tempfile.TemporaryDirectory() as tmp:
        old = run_mode("old", args.directory, rotations, tmp)
        new = run_mode("new", args.directory, rotations, tmp)
    if old is None or new is None:
        print(f"images: {n}")
        print("failed: a mode did not finish")
        return 1
    images, identical, differing = compare(old, new)
    print(f"images: {images}")
    print(f"identical: {identical}")
    print(f"differing: {differing}")
    print(f"seconds per image, old (1 engine, 1 thread, sequential): {old['seconds'] / images:.1f}")
    print(f"seconds per image, new (pool, threads, parallel): {new['seconds'] / images:.1f}")
    return 1 if differing else 0


if __name__ == "__main__":
    sys.exit(main())
