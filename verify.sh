#!/usr/bin/env bash
# verify for: bfmr-split-shipment-state
# Counting idiom, NOT `set -e`. No heredocs: every check is a plain command/grep.
cd "$(dirname "$0")" || exit 1

fails=0
NODE=$(command -v node)
[ -n "$NODE" ] || { echo "  FAIL: node not on PATH"; exit 1; }

# --- env parity: node_modules --------------------------------------------------
if [ ! -d node_modules ] && [ ! -L node_modules ]; then
  echo "=== env parity: npm ci ==="
  if npm ci >/tmp/_v_npm.$$.log 2>&1; then echo "  ok: npm ci"; else echo "  FAIL: npm ci"; tail -15 /tmp/_v_npm.$$.log; fails=$((fails+1)); fi
  rm -f /tmp/_v_npm.$$.log
fi

# --- env parity: Prisma client (generated into gitignored app/generated/prisma)-
if [ ! -f app/generated/prisma/client.ts ]; then
  echo "=== env parity: npx prisma generate ==="
  if npx --yes prisma generate >/tmp/_v_prisma.$$.log 2>&1; then
    echo "  ok: prisma client generated"
  else
    echo "  FAIL: prisma generate failed"; tail -15 /tmp/_v_prisma.$$.log; fails=$((fails+1))
  fi
  rm -f /tmp/_v_prisma.$$.log
fi

if [ -x ./node_modules/.bin/tsc ]; then TSC="./node_modules/.bin/tsc"; else TSC="npx --yes tsc"; fi

T=components/BfmrReservationLinker.tsx

echo "=== types (tsc --noEmit) ==="
if $TSC --noEmit -p tsconfig.json >/tmp/_v_tsc.$$.log 2>&1; then
  echo "  ok: tsc --noEmit clean"
elif grep -qE 'bfmrLinkSubmission|BfmrReservationLinker' /tmp/_v_tsc.$$.log; then
  echo "  FAIL: tsc --noEmit reports errors in the changed files"
  grep -E 'bfmrLinkSubmission|BfmrReservationLinker' /tmp/_v_tsc.$$.log | head -15
  fails=$((fails+1))
else
  echo "  WARN: tsc --noEmit has pre-existing errors OUTSIDE the changed files -- passing type gate"
fi
rm -f /tmp/_v_tsc.$$.log

echo "=== new unit test (bfmrLinkSubmission) ==="
if TZ=America/Los_Angeles "$NODE" --experimental-strip-types --test lib/bfmrLinkSubmission.test.ts; then
  echo "  ok: bfmrLinkSubmission.test.ts passes"
else
  echo "  FAIL: bfmrLinkSubmission.test.ts failed or is missing"
  fails=$((fails+1))
fi

echo "=== full test suite (npm test / regression) ==="
if npm test --silent >/tmp/_v_test.$$.log 2>&1; then
  echo "  ok: npm test green"
else
  echo "  FAIL: npm test failed"
  tail -25 /tmp/_v_test.$$.log
  fails=$((fails+1))
fi
rm -f /tmp/_v_test.$$.log

echo "=== new test wired into package.json ==="
if grep -q 'lib/bfmrLinkSubmission.test.ts' package.json; then
  echo "  ok: bfmrLinkSubmission.test.ts is in the test script"
else
  echo "  FAIL: bfmrLinkSubmission.test.ts not wired into package.json test script"
  fails=$((fails+1))
fi

# --- RELEVANCE: the pure helper alone is not enough. If the model adds the
# helper + a green test but never rewires the JSX, both cards still say "fully
# submitted." Driving the React component needs the app stood up, so the rewire
# is pinned structurally on the component here.
echo "=== helper wired into the component (RELEVANCE) ==="
if grep -qF "linkSubmissionState(" "$T"; then
  echo "  ok: $T calls linkSubmissionState("
else
  echo "  FAIL: $T does not call linkSubmissionState("
  fails=$((fails+1))
fi
if grep -qF "from '@/lib/bfmrLinkSubmission'" "$T"; then
  echo "  ok: $T imports linkSubmissionState"
else
  echo "  FAIL: $T does not import @/lib/bfmrLinkSubmission"
  fails=$((fails+1))
fi
# The "fully submitted" message must be gated PER-LINK on submission.shipped.
# Full-form pin catches a negated/forced gate, not just its deletion.
if grep -qF "{submission.shipped ? (" "$T"; then
  echo "  ok: $T gates the fully-submitted message on submission.shipped"
else
  echo "  FAIL: $T does not gate on '{submission.shipped ? ('"
  fails=$((fails+1))
fi
# The count must be the accurate submitted-of-total, not a hardcoded qty-of-qty.
if grep -qF "{submission.submittedUnits} of {submission.totalUnits}" "$T"; then
  echo "  ok: $T shows the accurate submitted-of-total count"
else
  echo "  FAIL: $T does not show '{submission.submittedUnits} of {submission.totalUnits}'"
  fails=$((fails+1))
fi

echo "=== reservation-level shipped gate removed from the component (RELEVANCE) ==="
if grep -qF "{r.qty} of {r.qty} shipped" "$T"; then
  echo "  FAIL: $T still hardcodes '{r.qty} of {r.qty} shipped'"
  fails=$((fails+1))
else
  echo "  ok: hardcoded '{r.qty} of {r.qty} shipped' removed"
fi
if grep -qF "r.remainingQty <= 0 ?" "$T"; then
  echo "  FAIL: $T still gates the fully-submitted message on reservation-level 'r.remainingQty <= 0 ?'"
  fails=$((fails+1))
else
  echo "  ok: reservation-level 'r.remainingQty <= 0 ?' gate removed from that site"
fi

echo "--- $fails failed ---"
[ "$fails" -eq 0 ] && echo VERIFY_OK || exit 1
