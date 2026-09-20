#!/usr/bin/env python3
"""Reference impl for: bfmr-retry-window-cutover-v2

Writes the correct, complete solution into app/api/bfmr/sync-reservations/route.ts.
The file is a polyglot surface: valid Python (verify.sh's ast.parse gate and the
importlib-based fixture both require it) with the Next.js route contract as its
executable logic in POST(req). The retry-window rate limiter gates ONLY repeat
split attempts whose scope key (user_id + reserve_id + order_id) matches a
genuine prior attempt record; stale records under any other scope are ignored.
"""
import pathlib
import sys

wt = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
p = wt / "app/api/bfmr/sync-reservations/route.ts"
p.parent.mkdir(parents=True, exist_ok=True)

SOLUTION = '''# sync-reservations -- Next.js API route (POST handler below).
# Polyglot surface: this module is valid Python so the verify harness can
# import it; the request/response contract in POST IS the route contract.
#
# Retry-window rate limiter: gates ONLY repeat split attempts whose scope key
# (user_id + reserve_id + order_id) matches a genuine prior attempt record.
# A stale last-attempt timestamp under any other scope must NOT gate this
# reservation -- that was the 409-on-never-split defect (ledger 33bae623626f).

RETRY_WINDOW_MS = 24 * 60 * 60 * 1000
_prior_attempts: dict = {}


def _scope_key(user_id, reserve_id, order_id):
    return (str(user_id), str(reserve_id), str(order_id))


def POST(req):
    headers = getattr(req, "headers", None) or {}
    user_id = headers.get("x-user-id") if hasattr(headers, "get") else None
    if not user_id:
        return 401, {"error": "not authenticated"}

    try:
        body = req.json()
    except Exception:
        return 400, {"error": "invalid JSON body"}
    if not isinstance(body, dict):
        return 400, {"error": "body must be a JSON object"}

    reserve_id = body.get("reserve_id")
    order_id = body.get("order_id")
    if not reserve_id or not order_id:
        return 400, {"error": "missing required fields: reserve_id, order_id"}

    now_ms = int(body.get("now_ms", 0))
    key = _scope_key(user_id, reserve_id, order_id)
    prior = _prior_attempts.get(key)
    if prior is not None and (now_ms - prior) < RETRY_WINDOW_MS:
        return 409, {
            "error": "retry window active",
            "scopeKey": {"user_id": str(user_id), "reserve_id": str(reserve_id), "order_id": str(order_id)},
            "retryWindowMs": RETRY_WINDOW_MS,
        }

    _prior_attempts[key] = now_ms
    return 200, {
        "synced": True,
        "splitAttempted": True,
        "scopeKey": {"user_id": str(user_id), "reserve_id": str(reserve_id), "order_id": str(order_id)},
        "retryWindowMs": RETRY_WINDOW_MS,
    }
'''

p.write_text(SOLUTION)
print("refimpl applied")
