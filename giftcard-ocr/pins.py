"""Geometry-aware line reconstruction and PIN-candidate extraction.

Taken from the research project's `gc_common.py` essentially verbatim — this is
the part that turns PaddleOCR's per-box output into gift-card PIN candidates,
and it is load-bearing for the measured accuracy. PaddleOCR emits a PIN split
across several boxes (and sometimes reads a card rotated), so candidates are
built by walking reconstructed text lines in both directions and joining
adjacent boxes, then keeping only the strings whose length matches a real PIN.
"""

from __future__ import annotations

import math
import re

# Gift-card PINs in this dataset are 16 or 19 characters after normalisation.
PIN_LENS = (16, 19)


def norm(s) -> str:
    return re.sub(r"[^A-Z0-9]", "", str(s or "").upper())


def _rect(poly):
    """poly: list of (x, y). Return (cx, cy, ux, uy, length, height)."""
    pts = [(float(x), float(y)) for x, y in poly]
    n = len(pts)
    cx = sum(p[0] for p in pts) / n
    cy = sum(p[1] for p in pts) / n
    sxx = sum((p[0] - cx) ** 2 for p in pts) / n
    syy = sum((p[1] - cy) ** 2 for p in pts) / n
    sxy = sum((p[0] - cx) * (p[1] - cy) for p in pts) / n
    theta = 0.5 * math.atan2(2 * sxy, sxx - syy)
    ux, uy = math.cos(theta), math.sin(theta)
    proj = [(p[0] - cx) * ux + (p[1] - cy) * uy for p in pts]
    perp = [-(p[0] - cx) * uy + (p[1] - cy) * ux for p in pts]
    return cx, cy, ux, uy, max(max(proj) - min(proj), 1e-6), max(max(perp) - min(perp), 1e-6)


def group_lines(items):
    """items: dicts with 'text' and 'poly'. Returns lists of boxes ordered
    along each reconstructed line (both directions, since text direction is
    ambiguous on a photographed card)."""
    boxes = []
    for it in items:
        if not it.get("text"):
            continue
        try:
            cx, cy, ux, uy, ln, ht = _rect(it["poly"])
        except Exception:
            continue
        boxes.append(dict(it, cx=cx, cy=cy, ux=ux, uy=uy, ln=ln, ht=ht))

    n = len(boxes)
    parent = list(range(n))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    for i in range(n):
        for j in range(i + 1, n):
            A, B = boxes[i], boxes[j]
            if abs(A["ux"] * B["ux"] + A["uy"] * B["uy"]) < 0.966:  # ~15 degrees
                continue
            h = max(A["ht"], B["ht"])
            dx, dy = B["cx"] - A["cx"], B["cy"] - A["cy"]
            along = abs(dx * A["ux"] + dy * A["uy"])
            perp = abs(-dx * A["uy"] + dy * A["ux"])
            if perp > 0.7 * h:
                continue
            if along - (A["ln"] + B["ln"]) / 2.0 > 1.5 * h:
                continue
            union(i, j)

    comps = {}
    for i in range(n):
        comps.setdefault(find(i), []).append(boxes[i])

    lines = []
    for grp in comps.values():
        ux, uy = grp[0]["ux"], grp[0]["uy"]
        grp.sort(key=lambda b: b["cx"] * ux + b["cy"] * uy)
        lines.append(grp)
        if len(grp) > 1:
            lines.append(list(reversed(grp)))
    return lines


def extract_candidates_with_regions(items, max_join: int = 6):
    """Shape-filtered PIN candidates: whole boxes plus adjacent-box joins along
    each reconstructed line, kept only at PIN lengths.

    Returns {candidate: (x0, y0, x1, y1)} — the bounding box, in the coordinate
    space of the image that was OCR'd, of the detection box(es) the candidate
    was built from. The review UI needs that to zoom the user to the code
    instead of making them hunt for it in a full-card photo. When a candidate
    turns up more than once the first region found wins; they are the same
    string either way and any of its locations is a usable place to look.
    """
    regions: dict[str, tuple[float, float, float, float]] = {}

    def bbox(boxes):
        xs = [p[0] for b in boxes for p in b["poly"]]
        ys = [p[1] for b in boxes for p in b["poly"]]
        return (min(xs), min(ys), max(xs), max(ys))

    for it in items:
        s = norm(it.get("text"))
        if len(s) in PIN_LENS and s not in regions:
            try:
                regions[s] = bbox([it])
            except (ValueError, KeyError, TypeError):
                pass

    for line in group_lines(items):
        toks = [norm(b.get("text")) for b in line]
        for i in range(len(toks)):
            acc = ""
            for j in range(i, min(i + max_join, len(toks))):
                acc += toks[j]
                if len(acc) > max(PIN_LENS):
                    break
                if len(acc) in PIN_LENS and acc not in regions:
                    try:
                        regions[acc] = bbox(line[i:j + 1])
                    except (ValueError, KeyError, TypeError):
                        pass
    return regions


def extract_candidates(items, max_join: int = 6):
    """Just the candidate strings — the form the accuracy sweep scored."""
    return set(extract_candidates_with_regions(items, max_join))


def window_candidates(items):
    """Generous upper bound: every PIN-length window of the concatenated page
    text. Far noisier than extract_candidates — only useful as a fallback when
    the caller is matching against a known set of codes."""
    blob = "".join(norm(it.get("text")) for it in items)
    out = set()
    for L in PIN_LENS:
        for i in range(0, max(0, len(blob) - L + 1)):
            out.add(blob[i:i + L])
    return out
