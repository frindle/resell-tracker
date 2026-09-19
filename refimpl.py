#!/usr/bin/env python3
"""Reference impl for: rt-walmart555-tracking-fix

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
p = wt / 'sidecar/src/walmart.js'
t = p.read_text()

OLD = """    if (detail.tracking.length) order.trackingNumbers = detail.tracking.filter(t => t !== order.orderNumber);
    else if (detail.isStoreDelivery) order.trackingNumbers = [order.orderNumber];"""
NEW = """    const realTracking = detail.tracking.filter(t => t !== order.orderNumber);
    order.trackingNumbers = realTracking.length ? realTracking : [order.orderNumber.replace(/[^0-9]/g, '')];"""

assert OLD in t, "refimpl anchor not found -- did the target change?"
p.write_text(t.replace(OLD, NEW, 1))
print("refimpl applied")
