#!/usr/bin/env bash
# Diagnosis verify: DIAGNOSIS.md present, substantive, structured, and GROUNDED in
# REAL repo files (anti-fabrication). NOT set -e -- count fails and report.
cd "$(dirname "$0")" || exit 1
D="./DIAGNOSIS.md"
fails=0
fail(){ echo "  FAIL: $1"; fails=$((fails+1)); }

echo "=== DIAGNOSIS.md present + substantive ==="
if [ -f "$D" ]; then
  n=$(wc -c < "$D")
  [ "$n" -ge 500 ] && echo "  ok: $n bytes" || fail "too short ($n bytes; need >=500)"
else
  fail "DIAGNOSIS.md missing"; echo "--- $fails failed ---"; exit 1
fi

echo "=== required sections (Root cause / Evidence / Fix sketch) ==="
for h in "Root cause" "Evidence" "Fix sketch"; do
  grep -qiF "$h" "$D" && echo "  ok: $h" || fail "missing section: $h"
done

echo "=== names a file:line (root cause must be located) ==="
grep -qE '[A-Za-z0-9_./-]+\.(ts|tsx|js|prisma):[0-9]+' "$D" && echo "  ok: file:line present" \
  || fail "no file:line reference -- root cause must be located precisely"

echo "=== grounded in REAL repo files (anti-fabrication) ==="
mapfile -t paths < <(grep -oE '`?[A-Za-z0-9_./-]+\.(ts|tsx|js|prisma)`?' "$D" | tr -d '`' | sed -E 's/:[0-9]+$//' | sort -u)
real=0; missing=()
for p in "${paths[@]}"; do
  if [ -f "./$p" ]; then real=$((real+1)); else missing+=("$p"); fi
done
echo "  real files cited: $real ; not-found: ${missing[*]:-none}"
[ "$real" -ge 2 ] && echo "  ok: >=2 real repo files cited" || fail "cite >=2 EXISTING repo files (got $real) -- grounding"

echo "=== references the concrete symptom (OrderBfmrLink / qty / trackingNumber) ==="
grep -qiE "OrderBfmrLink|reservation|trackingNumber|qty|quantity" "$D" \
  && echo "  ok: engages the actual defect domain" || fail "does not reference the link/qty/tracking domain"

echo "--- $fails failed ---"
[ "$fails" -eq 0 ] && echo VERIFY_OK || exit 1
