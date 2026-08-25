"""HTTP front end for the gift-card OCR service.

Deliberately tiny and standalone: no database, no knowledge of resell-tracker's
schema, no callbacks into the app. Image bytes in, PIN candidates out. That
keeps the service boundary at "OCR", so whatever user flow eventually consumes
it can decide matching/confirmation policy on the app side where the data is.

Endpoints
  GET  /health   liveness + which model set and variants are configured
  POST /ocr      one image -> per-variant candidates + merged agreement

`POST /ocr` accepts, in order of preference:
  * multipart/form-data with a `file` (or `image`) part
  * application/json  {"image_base64": "..."}
  * a raw image body (any other content type)

Optional per-request overrides: `variants` (comma-separated), `include_windows`.
"""

from __future__ import annotations

import base64
import binascii
import hmac
import os
import traceback

from flask import Flask, jsonify, request

import engine as engine_mod
import variants as variants_mod

MAX_BYTES = int(os.environ.get("OCR_MAX_BYTES", str(32 * 1024 * 1024)))

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_BYTES

ENGINE = engine_mod.Engine(
    model_set=os.environ.get("OCR_MODEL_SET", "medium"),
    long_edge=int(os.environ.get("OCR_LONG_EDGE", str(variants_mod.DEFAULT_LONG_EDGE))),
)

CONFIGURED_VARIANTS = [
    v.strip() for v in
    os.environ.get("OCR_VARIANTS", ",".join(engine_mod.DEFAULT_VARIANTS)).split(",")
    if v.strip()
]

SECRET = os.environ.get("GIFTCARD_OCR_SECRET", "")


def _authorised() -> bool:
    """Optional shared secret. Unset = open on the LAN, matching the main app's
    own "LAN-only default, opt into hardening" convention for SESSION_SECRET
    and friends."""
    if not SECRET:
        return True
    return hmac.compare_digest(request.headers.get("X-OCR-Secret", ""), SECRET)


def _truthy(v) -> bool:
    return str(v).lower() in ("1", "true", "yes", "on")


def _image_bytes():
    """Returns (data, error_message)."""
    f = request.files.get("file") or request.files.get("image")
    if f is not None:
        return f.read(), None
    if request.is_json:
        body = request.get_json(silent=True) or {}
        b64 = body.get("image_base64") or body.get("imageBase64")
        if not b64:
            return None, "json body needs image_base64"
        if "," in b64[:64] and b64.lstrip().startswith("data:"):
            b64 = b64.split(",", 1)[1]  # tolerate a data: URL
        try:
            return base64.b64decode(b64, validate=False), None
        except (binascii.Error, ValueError):
            return None, "image_base64 is not valid base64"
    data = request.get_data(cache=False)
    if data:
        return data, None
    return None, "no image in request"


@app.get("/health")
def health():
    return jsonify({
        "ok": True,
        "service": "giftcard-ocr",
        "model_set": ENGINE.model_set,
        "long_edge": ENGINE.long_edge,
        "variants": CONFIGURED_VARIANTS,
        "model_loaded": ENGINE.loaded,
        "heif_support": variants_mod.HEIF_OK,
        "max_bytes": MAX_BYTES,
    })


@app.post("/ocr")
def ocr():
    if not _authorised():
        return jsonify({"ok": False, "error": "unauthorised"}), 401

    data, err = _image_bytes()
    if err:
        return jsonify({"ok": False, "error": err}), 400

    names = request.args.get("variants") or request.form.get("variants")
    if not names and request.is_json:
        names = (request.get_json(silent=True) or {}).get("variants")
    if isinstance(names, str):
        names = [v.strip() for v in names.split(",") if v.strip()]
    names = names or CONFIGURED_VARIANTS

    unknown = [n for n in names for op in n.split("+") if op not in variants_mod.OPS]
    if unknown:
        return jsonify({"ok": False, "error": f"unknown variant op in: {unknown[0]}"}), 400

    try:
        result = ENGINE.read(
            data,
            variant_names=names,
            include_windows=_truthy(request.args.get("include_windows")),
        )
    except Exception as exc:  # noqa: BLE001 - surface the failure to the caller
        traceback.print_exc()
        return jsonify({"ok": False, "error": f"{type(exc).__name__}: {exc}"}), 500

    return jsonify(result)


if __name__ == "__main__":
    from waitress import serve

    port = int(os.environ.get("PORT", "8080"))
    if _truthy(os.environ.get("OCR_PRELOAD", "true")):
        ENGINE.load()  # pay the model-build cost at boot, not on the first request
    print(f"[giftcard-ocr] listening on 0.0.0.0:{port} "
          f"model_set={ENGINE.model_set} variants={CONFIGURED_VARIANTS}", flush=True)
    # Single worker thread: PaddleOCR predictors are not concurrency-safe and
    # Engine serialises on a lock anyway, so extra threads would only queue.
    serve(app, host="0.0.0.0", port=port, threads=1)
