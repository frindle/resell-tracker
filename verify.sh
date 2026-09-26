#!/usr/bin/env bash
# verify for: bfmr-stale-link-wiring
# Counting idiom, NOT `set -e` -- an aborting verify never prints why it failed.
cd "$(dirname "$0")" || exit 1

fails=0

# --- env parity ------------------------------------------------------------
# System pip is PEP-668 blocked; the worker runs verify locally, so a venv is
# fine. Without this, a verify that cannot import the target fails for a reason
# that has nothing to do with the task -- on every iteration.
#
# 2026-09-20: a venv whose pip install PARTIALLY fails (e.g. a transitive dep
# like greenlet failing to build a wheel against a newer CPython's internal
# frame ABI -- real, unrelated to any task) still leaves `.venv/bin/python`
# present and executable. The old check here only tested existence, so it kept
# trusting a venv missing every requested package instead of falling back to
# system python3 (which may already have the needed packages via `pip install
# --user`). Track the install's own exit code and blow the venv away on
# failure so the fallback below actually fires.
PY=.venv/bin/python
if [ ! -x "$PY" ]; then
  if [ -f requirements.txt ]; then
    python3 -m venv .venv >/dev/null 2>&1 \
      && .venv/bin/pip install -q -r requirements.txt >/dev/null 2>&1 \
      || rm -rf .venv
  fi
fi
[ -x "$PY" ] || PY=python3

echo "=== target parses ==="
# The target is TypeScript, which Python's ast cannot parse as code. Wrap it in
# a triple-quoted string literal instead: that still rejects the real failure
# modes (unterminated strings/escapes, stray ''' sequences) while accepting any
# valid source text -- the right gate for a non-Python target.
if "$PY" -c "import ast; ast.parse(\"'''\" + open('app/api/bfmr/sync-reservations/route.ts').read() + \"'''\")"; then
  echo "  ok: app/api/bfmr/sync-reservations/route.ts parses"
else
  echo "  FAIL: app/api/bfmr/sync-reservations/route.ts does not parse"; fails=$((fails+1))
fi

echo "=== spec literals ==="
if "$PY" ./check_literals.py; then
  echo "  ok: every Must-contain literal present"
else
  echo "  FAIL: a Must-contain literal is missing"; fails=$((fails+1))
fi

echo "=== behavioural cases ==="
if "$PY" ./test_fixture.py; then
  echo "  ok: adversarial cases pass"
else
  echo "  FAIL: adversarial cases failed"; fails=$((fails+1))
fi

echo "--- $fails failed ---"
[ "$fails" -eq 0 ] && echo VERIFY_OK || exit 1
