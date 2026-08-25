"""Preprocessing variants for gift-card OCR.

Port of the macOS CoreImage tool that produced the accuracy numbers in
README.md (`gc-preprocess.swift` from the giftcard-ocr research project) to
Pillow/NumPy so it runs in a Linux container with no GPU and no CoreImage.

The op names and the pipeline shape are kept identical to the original so a
variant string from the research results (e.g. "redchan+stretch14") means the
same thing here. The maths is NOT bit-identical to CoreImage — CoreImage works
in a linear-light working space and its photo-effect/temperature filters carry
undocumented tone curves. The port was therefore re-measured end-to-end against
the same 28-image / 46-confirmed-PIN set rather than assumed equivalent; see
README.md for the numbers it actually scored.

Pipeline (unchanged from the original):
  1. decode, apply EXIF orientation (iPhone HEICs carry rotation)
  2. prescale once to long_edge * 1.5 (Lanczos)
  3. apply the '+'-separated op chain in order
  4. Lanczos resize to long_edge, last
"""

from __future__ import annotations

import io
import math

import numpy as np
from PIL import Image, ImageOps

try:  # HEIC/HEIF support is optional — JPEG/PNG work without it.
    import pillow_heif

    pillow_heif.register_heif_opener()
    HEIF_OK = True
except Exception:  # pragma: no cover - depends on wheel availability
    HEIF_OK = False

DEFAULT_LONG_EDGE = 1024


# --------------------------------------------------------------------------
# colour ops
# --------------------------------------------------------------------------

def _arr(im: Image.Image) -> np.ndarray:
    return np.asarray(im.convert("RGB"), dtype=np.float32)


def _img(a: np.ndarray) -> Image.Image:
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), "RGB")


def _channel_broadcast(im: Image.Image, ch: int) -> Image.Image:
    a = _arr(im)
    c = a[:, :, ch]
    return _img(np.dstack([c, c, c]))


def _mono(im: Image.Image) -> Image.Image:
    # CIPhotoEffectMono is a mono conversion plus a mild contrast S-curve.
    # Rec.709 luma reproduces the conversion; the curve is left off because
    # `gamma08`/`gamma12` already cover the tone axis as separate variants.
    a = _arr(im)
    y = 0.2126 * a[:, :, 0] + 0.7152 * a[:, :, 1] + 0.0722 * a[:, :, 2]
    return _img(np.dstack([y, y, y]))


def _kelvin_rgb(kelvin: float) -> np.ndarray:
    """Approximate sRGB of a black-body radiator (Tanner Helland fit)."""
    t = kelvin / 100.0
    if t <= 66:
        r = 255.0
        g = 99.4708025861 * math.log(t) - 161.1195681661
    else:
        r = 329.698727446 * ((t - 60) ** -0.1332047592)
        g = 288.1221695283 * ((t - 60) ** -0.0755148492)
    if t >= 66:
        b = 255.0
    elif t <= 19:
        b = 0.0
    else:
        b = 138.5177312231 * math.log(t - 10) - 305.0447927307
    return np.array([max(r, 1.0), max(g, 1.0), max(b, 1.0)], dtype=np.float32)


def _temperature(im: Image.Image, target_k: float, neutral_k: float = 6500.0) -> Image.Image:
    """Von-Kries-style white-balance shift, the principled form of what
    CITemperatureAndTint(inputNeutral=6500, inputTargetNeutral=target) does."""
    mult = _kelvin_rgb(target_k) / _kelvin_rgb(neutral_k)
    mult = mult / mult.max()  # normalise so nothing clips to white
    return _img(_arr(im) * mult[None, None, :])


def _gamma(im: Image.Image, power: float) -> Image.Image:
    a = _arr(im) / 255.0
    return _img(np.power(a, power) * 255.0)


def _hue(im: Image.Image, degrees: float) -> Image.Image:
    # Standard YIQ hue-rotation matrix (same transform CIHueAdjust applies).
    c, s = math.cos(math.radians(degrees)), math.sin(math.radians(degrees))
    m = np.array([
        [0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928],
        [0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.140, 0.072 - c * 0.072 - s * 0.283],
        [0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072],
    ], dtype=np.float32)
    return _img(_arr(im) @ m.T)


# --------------------------------------------------------------------------
# geometry ops
# --------------------------------------------------------------------------

def _scale(im: Image.Image, sx: float, sy: float) -> Image.Image:
    w, h = im.size
    return im.resize((max(1, int(round(w * sx))), max(1, int(round(h * sy)))), Image.LANCZOS)


def _affine(im: Image.Image, a: float, b: float, c: float, d: float) -> Image.Image:
    """Apply [[a,c],[b,d]] about the image centre, growing the canvas so the
    transform never crops (the original re-seated the CIImage extent for the
    same reason)."""
    w, h = im.size
    corners = [(0, 0), (w, 0), (0, h), (w, h)]
    xs = [a * x + c * y for x, y in corners]
    ys = [b * x + d * y for x, y in corners]
    nw = max(1, int(math.ceil(max(xs) - min(xs))))
    nh = max(1, int(math.ceil(max(ys) - min(ys))))
    det = a * d - b * c
    if abs(det) < 1e-9:
        return im
    # PIL's AFFINE maps output -> input, so feed it the inverse.
    ia, ic = d / det, -c / det
    ib, id_ = -b / det, a / det
    tx, ty = min(xs), min(ys)
    return im.transform(
        (nw, nh), Image.AFFINE,
        (ia, ic, ia * tx + ic * ty, ib, id_, ib * tx + id_ * ty),
        resample=Image.BICUBIC, fillcolor=(255, 255, 255),
    )


OPS = {
    # colour axis
    "normal": lambda im: im,
    "redchan": lambda im: _channel_broadcast(im, 0),
    "greenchan": lambda im: _channel_broadcast(im, 1),
    "bluechan": lambda im: _channel_broadcast(im, 2),
    "grayscale": _mono,
    "inverted": lambda im: _img(255.0 - _arr(im)),
    "warmtint": lambda im: _temperature(im, 4000),
    "cooltint": lambda im: _temperature(im, 9000),
    "hue90": lambda im: _hue(im, 90),
    "hue180": lambda im: _hue(im, 180),
    "gamma08": lambda im: _gamma(im, 0.8),
    "gamma12": lambda im: _gamma(im, 1.2),
    # geometry axis
    "stretch14": lambda im: _scale(im, 1.0, 1.4),
    "squeeze07": lambda im: _scale(im, 1.0, 0.7),
    "hstretch14": lambda im: _scale(im, 1.4, 1.0),
    "shearP8": lambda im: _affine(im, 1, 0, math.tan(math.radians(8)), 1),
    "shearN8": lambda im: _affine(im, 1, 0, math.tan(math.radians(-8)), 1),
    "rot3": lambda im: _affine(im, math.cos(math.radians(3)), math.sin(math.radians(3)),
                               -math.sin(math.radians(3)), math.cos(math.radians(3))),
    "rotN3": lambda im: _affine(im, math.cos(math.radians(-3)), math.sin(math.radians(-3)),
                                -math.sin(math.radians(-3)), math.cos(math.radians(-3))),
}


class UnknownOp(ValueError):
    pass


def _resize_long(im: Image.Image, long_edge: float) -> Image.Image:
    w, h = im.size
    scale = long_edge / float(max(w, h))
    if abs(scale - 1.0) < 0.001:
        return im
    return im.resize((max(1, int(round(w * scale))), max(1, int(round(h * scale)))), Image.LANCZOS)


def load_base(data: bytes, long_edge: int = DEFAULT_LONG_EDGE) -> Image.Image:
    """Decode once, honour EXIF rotation, prescale once to long_edge * 1.5."""
    im = Image.open(io.BytesIO(data))
    im = ImageOps.exif_transpose(im) or im
    im = im.convert("RGB")
    return _resize_long(im, long_edge * 1.5)


def render(base: Image.Image, variant: str, long_edge: int = DEFAULT_LONG_EDGE) -> Image.Image:
    """Apply one '+'-separated op chain, then Lanczos down to long_edge."""
    im = base
    for op in variant.split("+"):
        fn = OPS.get(op)
        if fn is None:
            raise UnknownOp(f"unknown op: {op}")
        im = fn(im)
    return _resize_long(im, long_edge)


def to_jpeg(im: Image.Image, quality: int = 90) -> bytes:
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=quality)
    return buf.getvalue()


def render_to_jpeg(base: Image.Image, variant: str, long_edge: int = DEFAULT_LONG_EDGE,
                   quality: int = 90) -> bytes:
    return to_jpeg(render(base, variant, long_edge), quality)
