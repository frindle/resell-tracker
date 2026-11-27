"""Download and warm every OCR model set at image-build time.

Run from the Dockerfile so the weights live in the image layer instead of being
fetched on the first request. Also doubles as a build-time smoke test: it runs a
real detect+recognise pass over a synthetic image, so a broken wheel combination
fails the `docker build` rather than the first curl.
"""

import io

# engine first: it sets the thread env vars before numpy/paddle load.
import engine as engine_mod  # isort: skip
import variants as variants_mod  # isort: skip
from concurrent.futures import ThreadPoolExecutor

from PIL import Image, ImageDraw


def _sample_png() -> bytes:
    im = Image.new("RGB", (600, 200), "white")
    d = ImageDraw.Draw(im)
    d.text((20, 80), "NAAWGLYUYCN382DY", fill="black")
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


def main():
    data = _sample_png()
    for name in engine_mod.MODEL_SETS:
        # The pool exactly as the server builds it, so a bad cpu_threads value
        # or a pool bug fails the image build here, not on the first request.
        pool = engine_mod.EnginePool(size=engine_mod.POOL_SIZE, model_set=name,
                                     cpu_threads=engine_mod.THREADS)
        pool.load()
        base = variants_mod.load_base(data, pool.long_edge)
        base.load()
        # One read on every engine at once; any exception propagates and
        # fails the build.
        with ThreadPoolExecutor(max_workers=pool.size) as ex:
            futures = [ex.submit(e.run_variant, base, "grayscale") for e in pool.engines]
            results = [f.result() for f in futures]
        for i, r in enumerate(results):
            print(f"[preload] {name} engine {i}: boxes={len(r['items'])} "
                  f"elapsed={r['elapsed']:.1f}s", flush=True)
        print(f"[preload] {name}: pool={pool.size} threads={pool.cpu_threads} ok", flush=True)


if __name__ == "__main__":
    main()
