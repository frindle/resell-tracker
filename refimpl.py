#!/usr/bin/env python3
"""Reference impl for: sync-status-overflow

Minimal Tailwind flex-truncation fix: add `min-w-0` to the label span's
className so the flex child can shrink and `truncate` actually ellipsizes,
keeping the row inside the w-72 box.
"""
import pathlib
import sys

wt = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
p = wt / 'components/SyncStatusIndicator.tsx'
t = p.read_text()

OLD = '<span className="text-sm text-gray-200 truncate">{commandLabel(c.type)}</span>'
NEW = '<span className="text-sm text-gray-200 truncate min-w-0">{commandLabel(c.type)}</span>'

assert OLD in t, "refimpl anchor not found -- did the target change?"
p.write_text(t.replace(OLD, NEW, 1))
print("refimpl applied")
