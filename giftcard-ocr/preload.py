"""Download and warm every OCR model set at image-build time.

Run from the Dockerfile so the weights live in the image layer instead of being
fetched on the first request. Also doubles as a build-time smoke test: it runs a
real detect+recognise pass over a synthetic image, so a broken wheel combination
fails the `docker build` rather than the first curl.
"""

import io

from PIL import Image, ImageDraw

import engine as engine_mod


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
        eng = engine_mod.Engine(model_set=name)
        result = eng.read(data, variant_names=["grayscale"])
        print(f"[preload] {name}: ok={result['ok']} "
              f"boxes={result['variants'][0]['n_boxes']} "
              f"elapsed={result['elapsed_s']}s", flush=True)


if __name__ == "__main__":
    main()
