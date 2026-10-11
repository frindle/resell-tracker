#!/usr/bin/env python3
"""Check that app/api/import/route.ts contains all Must-contain literals."""
import sys
from pathlib import Path

ROUTE = Path("app/api/import/route.ts")
if not ROUTE.exists():
    print("FAIL: app/api/import/route.ts not found")
    sys.exit(1)

content = ROUTE.read_text()

MUST_CONTAIN = [
    "cancelled",
    "ImportRow",
    "cancelledMarked",
    "skippedCancelled",
    "cost",
    "salePrice",
    "existing.cost !== 0",
]

ok = True
for lit in MUST_CONTAIN:
    if lit in content:
        print(f"  ok: found '{lit}'")
    else:
        print(f"  FAIL: missing '{lit}'")
        ok = False

if ok:
    print("all literals present")
    sys.exit(0)
else:
    sys.exit(1)
