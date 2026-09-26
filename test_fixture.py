"""Adversarial fixture for: bfmr-stale-link-migration

>>> THE ONE THING THE GENERATOR CANNOT WRITE FOR YOU <<<

CASES is empty and the verify FAILS until you fill it in. That is deliberate.
A generator can emit a verify that DISCRIMINATES (fails at baseline, passes on
a fix). It cannot decide whether the verify is RELEVANT -- whether it tests the
property the task actually asked for. A benign case passes broken work.

Pick inputs that separate "did the job" from "made the test go green":
  * the exact boundary the defect is about, and one on each side of it
  * the degenerate inputs (missing key, None, empty, wrong type) that must NOT
    raise
  * at least one case that a plausible WRONG fix would fail
  * the regression half: things that already work and must keep working

Each case: (description, callable_returning_actual, expected)

The target is TypeScript; Node 26 imports it directly. The loader below drives
the REAL module through node (same process model as the app), not a re-implementation.
"""
import json
import subprocess
import sys

_DRIVER = r"""
import { resolveStaleReservationLinkMigrations, matchSplitGroups } from './lib/bfmrJoin.ts';
const [a, b] = JSON.parse(process.argv[1]);
if (process.env.FX_FN === 'matchSplitGroups') {
  console.log(JSON.stringify(matchSplitGroups(a, b)));
} else {
  console.log(JSON.stringify(resolveStaleReservationLinkMigrations(a, b)));
}
"""


def _call(fn, a, b):
    env = {"PATH": "/usr/bin:/bin:/opt/homebrew/bin", "FX_FN": fn}
    r = subprocess.run(
        ["node", "--input-type=module", "-e", _DRIVER, json.dumps([a, b])],
        capture_output=True, text=True, timeout=60, env=env,
    )
    if r.returncode != 0:
        raise RuntimeError("node driver failed: " + (r.stderr or r.stdout)[:500])
    return json.loads(r.stdout.strip().splitlines()[-1])


def resolve(bare, live):
    return _call("resolveStaleReservationLinkMigrations", bare, live)


CASES = [
    # --- the exact boundary: exactly one bare + exactly one qty-matching live -> migrate
    ("unambiguous 1:1 group migrates the link",
     lambda: resolve(
         [{"id": 101, "reserveId": "R-A", "qty": 2}],
         [{"id": 201, "reserveId": "R-A", "qty": 2}]),
     [{"fromId": 101, "toId": 201}]),

    # --- >1 qty-matching live rows in the group -> NOTHING (never guess)
    ("two qty-matching live siblings resolve to nothing",
     lambda: resolve(
         [{"id": 101, "reserveId": "R-A", "qty": 2}],
         [{"id": 201, "reserveId": "R-A", "qty": 2}, {"id": 202, "reserveId": "R-A", "qty": 2}]),
     []),

    # --- a plausible wrong fix: reject the whole group because it has >1 live rows.
    # Exactly ONE of them matches qty -> that one is unambiguous and must migrate.
    ("one-of-two live siblings matches qty exactly -> still migrates",
     lambda: resolve(
         [{"id": 101, "reserveId": "R-A", "qty": 2}],
         [{"id": 201, "reserveId": "R-A", "qty": 3}, {"id": 202, "reserveId": "R-A", "qty": 2}]),
     [{"fromId": 101, "toId": 202}]),

    # --- >1 bare-linked rows in the group -> NOTHING even if live side is clean
    ("two stale bare rows in one group resolve to nothing",
     lambda: resolve(
         [{"id": 101, "reserveId": "R-A", "qty": 2}, {"id": 102, "reserveId": "R-A", "qty": 2}],
         [{"id": 201, "reserveId": "R-A", "qty": 2}]),
     []),

    # --- a real BFMR split divides qty across siblings: no exact match -> untouched
    ("split sibling with half qty is left untouched",
     lambda: resolve(
         [{"id": 101, "reserveId": "R-A", "qty": 4}],
         [{"id": 201, "reserveId": "R-A", "qty": 2}, {"id": 202, "reserveId": "R-A", "qty": 2}]),
     []),

    # --- zero live rows in the group -> NOTHING (no crash)
    ("bare row with no live sibling resolves to nothing",
     lambda: resolve(
         [{"id": 101, "reserveId": "R-A", "qty": 2}],
         [{"id": 201, "reserveId": "R-B", "qty": 2}]),
     []),

    # --- null / empty reserveId rows are skipped entirely and must not raise
    ("null and empty reserveIds are skipped without raising",
     lambda: resolve(
         [{"id": 101, "reserveId": None, "qty": 2}, {"id": 102, "reserveId": "", "qty": 2}],
         [{"id": 201, "reserveId": None, "qty": 2}]),
     []),

    # --- degenerate: empty inputs -> nothing, no raise
    ("empty input arrays resolve to nothing",
     lambda: resolve([], []),
     []),

    # --- groups are per-reserveId: a match in one group must not leak into another
    ("distinct reserveIds do not cross-match; valid group still migrates",
     lambda: resolve(
         [{"id": 101, "reserveId": "R-A", "qty": 2}, {"id": 103, "reserveId": "R-C", "qty": 5}],
         [{"id": 201, "reserveId": "R-B", "qty": 2}, {"id": 203, "reserveId": "R-C", "qty": 5}]),
     [{"fromId": 103, "toId": 203}]),

    # --- regression half: the pre-existing split resolver must keep working
    ("regression: matchSplitGroups still resolves a genuine split pair",
     lambda: _call("matchSplitGroups",
                   [{"id": 7, "reserved_at": "2026-08-25 12:05:05", "item_model_number": "MX2D3AM/A", "qty": "1"},
                    {"id": 8, "reserved_at": "2026-08-25 12:05:05", "item_model_number": "MX2D3AM/A", "qty": "1"}],
                   [{"reserved_at": "08/25/2026 12:05:05", "item_model_number": "MX2D3AM/A", "qty": "2", "my_tracker_id": 4901929}]),
     [{"id": 7, "my_tracker_id": 4901929}, {"id": 8, "my_tracker_id": 4901929}]),
]


def main():
    if len(CASES) < 3:
        print("  SCAFFOLD_INCOMPLETE: {} adversarial case(s) authored, need >= 3."
              .format(len(CASES)))
        print("  A generated scaffold is not a verify. Author the cases in "
              "test_fixture.py.")
        return 1
    fails = 0
    for desc, thunk, want in CASES:
        try:
            got = thunk()
        except Exception as e:
            print("  FAIL {} -- raised {}: {}".format(desc, type(e).__name__, e))
            fails += 1
            continue
        if got != want:
            print("  FAIL {} -- got {!r}, want {!r}".format(desc, got, want))
            fails += 1
    print("  {}/{} case(s) passed".format(len(CASES) - fails, len(CASES)))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
