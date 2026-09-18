#!/usr/bin/env python3
"""Reference impl for: sync-status-drag-resize

The gate applies this, runs the verify, and reverts it. It proves two things at
once: the task is SATISFIABLE as specified, and the verify actually ENFORCES the
spec (a refimpl that goes green while a "Must contain" literal is absent means
the verify is benign).

Write the SIMPLEST change that makes the verify pass. It doubles as your review
reference when the model's diff comes back.
"""
import pathlib
import sys

wt = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
p = wt / 'components/SyncStatusIndicator.tsx'
t = p.read_text()

OLD1 = """style={position ? { left: `${position.x}px`, top: `${position.y}px` } : undefined}"""
NEW1 = """style={position ? { left: `${position.x}px`, top: `${position.y}px`, right: 'auto', bottom: 'auto' } : undefined}"""

OLD2 = """<ul className="divide-y divide-gray-800">"""
NEW2 = """<ul className="divide-y divide-gray-800 max-h-96 overflow-y-auto">"""

assert OLD1 in t, "refimpl anchor 1 (style ternary) not found -- did the target change?"
assert OLD2 in t, "refimpl anchor 2 (ul className) not found -- did the target change?"
t = t.replace(OLD1, NEW1, 1)
t = t.replace(OLD2, NEW2, 1)
p.write_text(t)
print("refimpl applied")
