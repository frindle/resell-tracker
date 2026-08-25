"""PaddleOCR wrapper: image bytes in, PIN candidates per variant out.

CPU only, by construction. PaddleOCR's CPU build is what was benchmarked and it
is deliberately what ships here — this service must never contend for a GPU.
"""

from __future__ import annotations

import os
import tempfile
import threading
import time

import pins as pins_mod
import variants as variants_mod

# Single-threaded BLAS: the service handles one image at a time and oversized
# thread pools only add contention on a busy Unraid box. mkldnn off matches the
# benchmarked configuration.
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS", "1")
os.environ.setdefault("FLAGS_use_mkldnn", "0")

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
MODEL_SETS = {
    "medium": dict(
        text_detection_model_name="PP-OCRv6_medium_det",
        text_recognition_model_name="PP-OCRv6_medium_rec",
    ),
    "mobile": dict(
        text_detection_model_name="PP-OCRv5_mobile_det",
        text_recognition_model_name="PP-OCRv5_mobile_rec",
    ),
}


class Engine:
    """Lazily-built PaddleOCR instance guarded by a lock.

    PaddleOCR predictors are not safe to call concurrently, and building one
    costs seconds, so a single instance is created on first use and every
    request serialises through `_lock`.
    """

    def __init__(self, model_set: str = "medium", long_edge: int = variants_mod.DEFAULT_LONG_EDGE):
        if model_set not in MODEL_SETS:
            raise ValueError(f"unknown model set: {model_set}")
        self.model_set = model_set
        self.long_edge = long_edge
        self._ocr = None
        self._lock = threading.Lock()

    # -- lifecycle ---------------------------------------------------------

    def load(self):
        if self._ocr is None:
            from paddleocr import PaddleOCR

            self._ocr = PaddleOCR(
                lang="en",
                use_doc_orientation_classify=False,
                use_doc_unwarping=False,
                use_textline_orientation=False,
                enable_mkldnn=False,
                **MODEL_SETS[self.model_set],
            )
        return self._ocr

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

    def read(self, data: bytes, variant_names=None, include_windows: bool = False) -> dict:
        """Run the ensemble over one source image.

        Returns per-variant results plus a merged candidate list annotated with
        which variants produced each candidate, so a caller can apply its own
        agreement threshold rather than having one baked in here.
        """
        names = list(variant_names or DEFAULT_VARIANTS)
        t0 = time.time()
        base = variants_mod.load_base(data, self.long_edge)

        per_variant = []
        merged: dict[str, list[str]] = {}
        regions: dict[str, dict] = {}
        texts_all: list[str] = []
        windows: set[str] = set()

        with self._lock:
            for name in names:
                v0 = time.time()
                img = variants_mod.render(base, name, self.long_edge)
                vw, vh = img.size
                jpeg = variants_mod.to_jpeg(img)
                items = self._predict_bytes(jpeg)
                raw = pins_mod.extract_candidates_with_regions(items)
                cands = sorted(raw)
                entry = {
                    "variant": name,
                    "elapsed_s": round(time.time() - v0, 3),
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
            "model_set": self.model_set,
            "long_edge": self.long_edge,
            "elapsed_s": round(time.time() - t0, 3),
            "variants": per_variant,
            "candidates": candidates,
            "texts": texts_all,
            # Seen by every variant — the high-confidence subset.
            "consensus": [c["pin"] for c in candidates if c["agreement"] == len(names)],
        }
        if include_windows:
            out["windows"] = sorted(windows)
        return out
