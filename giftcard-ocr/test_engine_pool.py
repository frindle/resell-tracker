"""EnginePool scheduling: same results as one engine, parallel but never sharing an engine.

No paddle needed: fake engines stand in for the model.
"""
import io
import os
import sys
import threading
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from PIL import Image  # noqa: E402

import engine as engine_mod  # noqa: E402

# Made-up lines; the first is 16 characters so it counts as a candidate.
CANNED = {
    "slow": [{"text": "ABCD1234EFGH5678", "poly": [(10, 10), (110, 10), (110, 30), (10, 30)]},
             {"text": "hello", "poly": [(10, 40), (60, 40), (60, 60), (10, 60)]}],
    "fast": [{"text": "ABCD1234EFGH5678", "poly": [(12, 12), (112, 12), (112, 32), (12, 32)]},
             {"text": "WXYZ9876QRST5432", "poly": [(10, 70), (110, 70), (110, 90), (10, 90)]}],
}


def png_bytes() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (64, 32), "white").save(buf, "PNG")
    return buf.getvalue()


class Probe:
    """Shared across fake engines: how many reads ran at once."""

    def __init__(self):
        self.lock = threading.Lock()
        self.now = 0
        self.peak = 0

    def enter(self):
        with self.lock:
            self.now += 1
            self.peak = max(self.peak, self.now)

    def leave(self):
        with self.lock:
            self.now -= 1


class FakeEngine(engine_mod.Engine):
    def __init__(self, probe, fail_on=None):
        super().__init__("medium", 1024, 1)
        self.probe = probe
        self.fail_on = fail_on
        self.busy = 0
        self.overlap = False

    def run_variant(self, base, name):
        if name == self.fail_on:
            raise RuntimeError("boom")
        self.probe.enter()
        self.busy += 1
        if self.busy > 1:
            self.overlap = True
        try:
            time.sleep(0.15 if name == "slow" else 0.01)
            return {"name": name, "items": CANNED[name], "size": (100, 100), "elapsed": 0.0}
        finally:
            self.busy -= 1
            self.probe.leave()


    def orientation(self, data):
        self.probe.enter()
        self.busy += 1
        if self.busy > 1:
            self.overlap = True
        try:
            time.sleep(0.05)
            return {"ok": True}
        finally:
            self.busy -= 1
            self.probe.leave()


def strip_times(r):
    r = dict(r)
    r.pop("elapsed_s")
    r["variants"] = [{k: v for k, v in e.items() if k != "elapsed_s"} for e in r["variants"]]
    return r


class EnginePoolTest(unittest.TestCase):
    def pool(self, n, **kw):
        probe = Probe()
        engines = [FakeEngine(probe, **kw) for _ in range(n)]
        return engine_mod.EnginePool(engines=engines), engines, probe

    def test_same_result_as_one_engine_in_request_order(self):
        data = png_bytes()
        names = ["slow", "fast"]  # the slow one finishes last but is listed first
        pool, _, _ = self.pool(2)
        single = FakeEngine(Probe())
        for windows in (False, True):
            a = strip_times(pool.read(data, names, include_windows=windows))
            b = strip_times(single.read(data, names, include_windows=windows))
            self.assertEqual(a, b)
        self.assertEqual([v["variant"] for v in a["variants"]], names)

    def test_two_engines_run_variants_at_the_same_time(self):
        pool, _, probe = self.pool(2)
        pool.read(png_bytes(), ["slow", "fast"])
        self.assertEqual(probe.peak, 2)

    def test_one_engine_never_runs_two_reads_at_once(self):
        pool, engines, probe = self.pool(1)
        pool.read(png_bytes(), ["slow", "fast"])
        self.assertEqual(probe.peak, 1)
        self.assertFalse(engines[0].overlap)

    def test_overlapping_requests_never_share_an_engine(self):
        pool, engines, probe = self.pool(2)
        data = png_bytes()
        threads = [threading.Thread(target=pool.read, args=(data, ["slow", "fast"])) for _ in range(3)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertLessEqual(probe.peak, 2)
        self.assertFalse(any(e.overlap for e in engines))

    def test_orientation_shares_the_pool_slots_with_reads(self):
        pool, engines, probe = self.pool(2)
        data = png_bytes()
        jobs = [lambda: pool.read(data, ["slow", "fast"]) for _ in range(2)]
        jobs += [lambda: pool.orientation(data) for _ in range(3)]
        threads = [threading.Thread(target=j) for j in jobs]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertLessEqual(probe.peak, 2)
        self.assertFalse(any(e.overlap for e in engines))
        # Every slot came back: another read still completes.
        self.assertEqual(len(pool.read(data, ["slow", "fast"])["variants"]), 2)

    def test_failure_propagates_and_engines_are_returned(self):
        probe = Probe()
        bad = FakeEngine(probe, fail_on="fast")
        pool = engine_mod.EnginePool(engines=[bad])
        with self.assertRaises(RuntimeError):
            pool.read(png_bytes(), ["slow", "fast"])
        # The engine went back, so a later read still works.
        self.assertEqual(len(pool.read(png_bytes(), ["slow"])["variants"]), 1)


if __name__ == "__main__":
    unittest.main()
