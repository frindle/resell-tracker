"""Download every OCR model set's weights (image build, before the code is copied).

Building a PaddleOCR instance fetches its weights into the cache. This only
imports models.py, so editing engine/variants/pins doesn't invalidate the
Docker layer and re-download hundreds of MB. preload.py, run after the code is
copied, then smoke-tests against the cached weights.
"""

from paddleocr import PaddleOCR

from models import MODEL_SETS, PADDLE_KWARGS


def main():
    for name, names in MODEL_SETS.items():
        PaddleOCR(**PADDLE_KWARGS, **names)
        print(f"[fetch_models] {name}: ok", flush=True)


if __name__ == "__main__":
    main()
