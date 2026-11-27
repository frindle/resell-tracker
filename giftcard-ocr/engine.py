"""PaddleOCR wrapper: image bytes in, PIN candidates per variant out.

CPU only, by construction. PaddleOCR's CPU build is what was benchmarked and it
is deliberately what ships here — this service must never contend for a GPU.
"""

from __future__ import annotations

import os


def _int_env(name: str, default: int) -> int:
    try:
        return max(1, int(os.environ.get(name, "")))
    except ValueError:
        return default


# Threads per engine instance, and how many instances share the work. The
# total the OCR may use is about THREADS * POOL_SIZE cores (docker/start-ocr.sh
# pins the process to that many). Measured on a quiet box: 4 threads ~1.5x one
# thread, 8 threads ~1.7x, so two instances of 4 beat one of 8.
THREADS = _int_env("OCR_THREADS", 4)
POOL_SIZE = _int_env("OCR_POOL_SIZE", 2)

# Forced, not setdefault: an inherited OMP_NUM_THREADS=1 (the old image default)
# would silently cap every predictor at one thread whatever cpu_threads says.
# This block must stay above every import that can load numpy or paddle
# (pins, variants, models): they read these once, at import.
# mkldnn stays off: it crashes on this paddle.
os.environ["OMP_NUM_THREADS"] = str(THREADS)
os.environ["MKL_NUM_THREADS"] = str(THREADS)
os.environ.setdefault("FLAGS_use_mkldnn", "0")

import queue  # noqa: E402
import tempfile  # noqa: E402
import threading  # noqa: E402
import time  # noqa: E402
from concurrent.futures import ThreadPoolExecutor  # noqa: E402

import pins as pins_mod  # noqa: E402
import variants as variants_mod  # noqa: E402

# The two-variant ensemble that scored 46/46 on the confirmed set with THIS
# pipeline. Not the same pair as the original CoreImage research picked — see
# README.md, "What changed when the pipeline was ported". Order affects only
# the order results are reported in.
DEFAULT_VARIANTS = ("redchan+stretch14", "grayscale")

# Model names are pinned explicitly rather than left to PaddleOCR's built-in
# default. On paddleocr 3.7.0 the default happens to be PP-OCRv6_medium, which
# is what the accuracy below was measured with — but that default moves between
# releases, and a silent model swap on a `pip install` would invalidate the
# measurement without anything visibly changing.
# Model names live in models.py so the Docker layer that downloads the
# weights doesn't depend on (and isn't rebuilt by) changes to this file.
from models import MODEL_SETS, PADDLE_KWARGS  # noqa: E402

# Whole-page orientation classifier (0/90/180/270). Tiny and CPU-cheap; its
# weights come from fetch_orient_model.py in a layer of their own.
ORIENT_MODEL = "PP-LCNet_x1_0_doc_ori"


# Building a predictor touches paddle/paddlex global state; do it one at a time
# across every Engine in the process.
_BUILD_LOCK = threading.Lock()


class Engine:
    """Lazily-built PaddleOCR instance guarded by a lock.

    PaddleOCR predictors are not safe to call concurrently, and building one
    costs seconds, so one instance is created on first use and every call on
    THIS engine serialises through `_lock`. Parallelism comes from EnginePool
    owning several engines, never from sharing one.
    """

    def __init__(self, model_set: str = "medium", long_edge: int = variants_mod.DEFAULT_LONG_EDGE,
                 cpu_threads: int | None = None):
        if model_set not in MODEL_SETS:
            raise ValueError(f"unknown model set: {model_set}")
        self.model_set = model_set
        self.long_edge = long_edge
        # None = do not pass cpu_threads to PaddleOCR at all (what shipped before).
        self.cpu_threads = cpu_threads
        self._ocr = None
        self._orient = None
        self._lock = threading.Lock()

    # -- lifecycle ---------------------------------------------------------

    def load(self):
        with _BUILD_LOCK:
            if self._ocr is None:
                from paddleocr import PaddleOCR

                extra = {} if self.cpu_threads is None else {"cpu_threads": self.cpu_threads}
                self._ocr = PaddleOCR(**PADDLE_KWARGS, **extra, **MODEL_SETS[self.model_set])
        return self._ocr

    def load_orient(self):
        with _BUILD_LOCK:
            if self._orient is None:
                from paddleocr import DocImgOrientationClassification

                self._orient = DocImgOrientationClassification(model_name=ORIENT_MODEL)
        return self._orient

    def orientation(self, data: bytes) -> dict:
        """Which way the photo has to turn to read upright.

        `rotation` is the CLOCKWISE turn (0/90/180/270) to apply to the
        EXIF-corrected image, matching how the tracker stores display rotation.
        The classifier's label is how far the content is already turned
        clockwise, so the fix is the opposite turn.
        """
        base = variants_mod.load_base(data, self.long_edge)
        jpeg = variants_mod.to_jpeg(base)
        fd, path = tempfile.mkstemp(suffix=".jpg")
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(jpeg)
            # Same lock as reads: one predictor of this engine at a time. The
            # pool lends the engine out, so in the service this never waits.
            with self._lock:
                res = list(self.load_orient().predict(path))[0]
            j = res.json["res"]
            label = int(str(j["label_names"][0]))
            score = float(j["scores"][0])
        finally:
            try:
                os.unlink(path)
            except OSError:
                pass
        return {"ok": True, "label": label, "rotation": (360 - label) % 360, "score": round(score, 3)}

    @property
    def loaded(self) -> bool:
        return self._ocr is not None

    # -- inference ---------------------------------------------------------

    def _predict_bytes(self, jpeg: bytes):
        """Run the detector/recogniser and return ([{'text','poly'}, ...], (w, h))."""
        ocr = self.load()
        # PaddleOCR.predict wants a path or an ndarray; a temp file keeps the
        # decode path identical to how the benchmark ran.
        fd, path = tempfile.mkstemp(suffix=".jpg")
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(jpeg)
            items = []
            for res in ocr.predict(path):
                texts = res.get("rec_texts") or []
                polys = res.get("rec_polys")
                if polys is None:
                    polys = res.get("dt_polys") or []
                for t, p in zip(texts, polys):
                    items.append({"text": t, "poly": [(float(a), float(b)) for a, b in p]})
            return items
        finally:
            try:
                os.unlink(path)
            except OSError:
                pass

    def run_variant(self, base, name: str) -> dict:
        """Render one variant of `base` and read it. Holds this engine's lock."""
        with self._lock:
            v0 = time.time()
            img = variants_mod.render(base, name, self.long_edge)
            vw, vh = img.size
            jpeg = variants_mod.to_jpeg(img)
            items = self._predict_bytes(jpeg)
            return {"name": name, "items": items, "size": (vw, vh), "elapsed": time.time() - v0}

    def read(self, data: bytes, variant_names=None, include_windows: bool = False) -> dict:
        """Run the ensemble over one source image, one variant after another.

        Returns per-variant results plus a merged candidate list annotated with
        which variants produced each candidate, so a caller can apply its own
        agreement threshold rather than having one baked in here.
        """
        names = list(variant_names or DEFAULT_VARIANTS)
        t0 = time.time()
        base = variants_mod.load_base(data, self.long_edge)
        outs = [self.run_variant(base, n) for n in names]
        return merge_variants(outs, names, self.model_set, self.long_edge, t0, include_windows)


def merge_variants(outs: list, names: list, model_set: str, long_edge: int, t0: float,
                   include_windows: bool = False) -> dict:
    """Fold per-variant reads (given in `names` order) into the response shape.

    Pure: the same reads give the same output however they were scheduled,
    which is what lets a pool run the variants in parallel.
    """
    per_variant = []
    merged: dict[str, list[str]] = {}
    regions: dict[str, dict] = {}
    texts_all: list[str] = []
    boxes: list[dict] = []
    windows: set[str] = set()

    for o in outs:
        name = o["name"]
        items = o["items"]
        vw, vh = o["size"]
        raw = pins_mod.extract_candidates_with_regions(items)
        cands = sorted(raw)
        entry = {
            "variant": name,
            "elapsed_s": round(o["elapsed"], 3),
            "n_boxes": len(items),
            "candidates": cands,
            # Always returned, never optional: a caller deciding
            # "this upload is a receipt, not a gift card" needs the
            # words, and a flag raised against a card has to stay
            # investigable after the fact. Both are cheap — a card
            # photo yields tens of short strings.
            "texts": [it["text"] for it in items],
        }
        per_variant.append(entry)
        texts_all.extend(it["text"] for it in items)
        # Where each line sits, as fractions of THIS variant's frame
        # (a turned variant's frame is turned too; the caller knows
        # which turn it asked for and maps back).
        if vw and vh:
            for it in items:
                xs = [p[0] for p in it["poly"]]
                ys = [p[1] for p in it["poly"]]
                if not xs:
                    continue
                boxes.append({"text": it["text"], "box": [
                    round(max(0.0, min(1.0, min(xs) / vw)), 4), round(max(0.0, min(1.0, min(ys) / vh)), 4),
                    round(max(0.0, min(1.0, max(xs) / vw)), 4), round(max(0.0, min(1.0, max(ys) / vh)), 4)]})
        for c in cands:
            merged.setdefault(c, []).append(name)
            # Fractions of the variant image, not pixels: the caller is
            # displaying the ORIGINAL upload, which has different
            # dimensions from whatever this variant rendered to. Every
            # op in the shipped ensemble is a colour change or an
            # axis-aligned scale, so a fraction of the variant is the
            # same fraction of the source. That is not true of the
            # shear/rotate ops, which are why this is documented rather
            # than assumed — do not put them in OCR_VARIANTS and then
            # trust the region.
            if c not in regions and vw and vh:
                x0, y0, x1, y1 = raw[c]
                regions[c] = {
                    "x": max(0.0, min(1.0, x0 / vw)),
                    "y": max(0.0, min(1.0, y0 / vh)),
                    "w": max(0.0, min(1.0, (x1 - x0) / vw)),
                    "h": max(0.0, min(1.0, (y1 - y0) / vh)),
                    "variant": name,
                }
        if include_windows:
            windows |= pins_mod.window_candidates(items)

    candidates = [
        {"pin": pin, "variants": vs, "agreement": len(vs), "region": regions.get(pin)}
        for pin, vs in sorted(merged.items(), key=lambda kv: (-len(kv[1]), kv[0]))
    ]
    out = {
        "ok": True,
        "model_set": model_set,
        "long_edge": long_edge,
        "elapsed_s": round(time.time() - t0, 3),
        "variants": per_variant,
        "candidates": candidates,
        "texts": texts_all,
        "boxes": boxes,
        # Seen by every variant — the high-confidence subset.
        "consensus": [c["pin"] for c in candidates if c["agreement"] == len(names)],
    }
    if include_windows:
        out["windows"] = sorted(windows)
    return out


class EnginePool:
    """Several independent engines; the variants of a request run in parallel.

    Each engine owns its own PaddleOCR object and lock, so nothing paddle-side
    is shared between threads. A variant job borrows a free engine for one
    read, which also lets two requests overlap safely. Only the scheduling
    differs from Engine.read: same pixels, same models, same merge.
    """

    def __init__(self, size: int = POOL_SIZE, model_set: str = "medium",
                 long_edge: int = variants_mod.DEFAULT_LONG_EDGE, cpu_threads: int | None = None,
                 engines: list | None = None):
        self.engines = engines if engines is not None else [
            Engine(model_set, long_edge, cpu_threads) for _ in range(max(1, size))
        ]
        self.model_set = model_set
        self.long_edge = long_edge
        self.cpu_threads = cpu_threads
        self._free: "queue.Queue[Engine]" = queue.Queue()
        for e in self.engines:
            self._free.put(e)

    @property
    def size(self) -> int:
        return len(self.engines)

    @property
    def loaded(self) -> bool:
        return all(e.loaded for e in self.engines)

    def load(self):
        """Build every instance now, one after another, so no request pays for it."""
        for e in self.engines:
            e.load()

    def _borrow(self, fn):
        """Run fn(engine) holding exactly one slot, never waiting for a second."""
        eng = self._free.get()
        try:
            return fn(eng)
        finally:
            self._free.put(eng)

    def orientation(self, data: bytes) -> dict:
        # Takes a slot like a read does, so predictors running at once never
        # exceed the pool size. Each engine builds its own small orient model
        # on first use.
        return self._borrow(lambda eng: eng.orientation(data))

    def _job(self, base, name: str) -> dict:
        return self._borrow(lambda eng: eng.run_variant(base, name))

    def read(self, data: bytes, variant_names=None, include_windows: bool = False) -> dict:
        names = list(variant_names or DEFAULT_VARIANTS)
        t0 = time.time()
        base = variants_mod.load_base(data, self.long_edge)
        base.load()  # fully decoded before several threads read it
        with ThreadPoolExecutor(max_workers=len(names)) as ex:
            futures = [ex.submit(self._job, base, n) for n in names]
            outs = [f.result() for f in futures]  # in `names` order
        return merge_variants(outs, names, self.model_set, self.long_edge, t0, include_windows)
