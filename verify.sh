#!/usr/bin/env bash
# verify for: bfmr-no-autosubmit
# Counting idiom, NOT `set -e` -- an aborting verify never prints why it failed.
# No heredocs: every check is a plain command / grep, so there is no unquoted
# heredoc feeding an interpreter and nothing for the shell to expand.
cd "$(dirname "$0")" || exit 1

fails=0
NODE=$(command -v node)     # the queue daemon runs under launchd's PATH
[ -n "$NODE" ] || { echo "  FAIL: node not on PATH"; exit 1; }

# --- env parity: node_modules --------------------------------------------------
# A linked git worktree has no node_modules of its own. It is normally symlinked
# to the primary checkout; if that link is missing, fall back to `npm ci` (the
# CI step). Without deps, tsc/tsx/node cannot resolve and every check dies for a
# reason that has nothing to do with the task.
if [ ! -d node_modules ] && [ ! -L node_modules ]; then
  echo "=== env parity: npm ci ==="
  if npm ci >/tmp/_v_npm.$$.log 2>&1; then echo "  ok: npm ci"; else echo "  FAIL: npm ci"; tail -15 /tmp/_v_npm.$$.log; fails=$((fails+1)); fi
  rm -f /tmp/_v_npm.$$.log
fi

# --- env parity: Prisma client -------------------------------------------------
# Prisma 7 generates the client into app/generated/prisma (gitignored), so a
# fresh worktree lacks it and EVERY prisma model type resolves to `any` -> a
# flood of TS7006 across the repo. This is the CI `npx prisma generate` step and
# the Node analogue of the python flavour's venv bootstrap. Run it if absent.
if [ ! -f app/generated/prisma/client.ts ]; then
  echo "=== env parity: npx prisma generate ==="
  if npx --yes prisma generate >/tmp/_v_prisma.$$.log 2>&1; then
    echo "  ok: prisma client generated"
  else
    echo "  FAIL: prisma generate failed"; tail -15 /tmp/_v_prisma.$$.log; fails=$((fails+1))
  fi
  rm -f /tmp/_v_prisma.$$.log
fi

# node_modules is symlinked from the primary checkout. Prefer its tsc; fall back
# to npx (network) only if absent.
if [ -x ./node_modules/.bin/tsc ]; then TSC="./node_modules/.bin/tsc"; else TSC="npx --yes tsc"; fi

T=lib/autoSubmitTracking.ts

echo "=== types (tsc --noEmit) ==="
# Run the project check, but only FAIL when the error is in a file this task
# touches. Pre-existing errors elsewhere WARN and pass (catches dead
# imports / unused vars from the BFMR removal, which land in the changed files).
if $TSC --noEmit -p tsconfig.json >/tmp/_v_tsc.$$.log 2>&1; then
  echo "  ok: tsc --noEmit clean"
elif grep -qE 'lib/autoSubmit(Channel|Tracking)' /tmp/_v_tsc.$$.log; then
  echo "  FAIL: tsc --noEmit reports errors in the changed files"
  grep -E 'lib/autoSubmit' /tmp/_v_tsc.$$.log | head -15
  fails=$((fails+1))
else
  echo "  WARN: tsc --noEmit has pre-existing errors OUTSIDE the changed files -- passing type gate"
fi
rm -f /tmp/_v_tsc.$$.log

echo "=== new unit test (autoSubmitChannel) ==="
# Explicit run of the new file: catches the case where the model wrote the test
# but never wired it into package.json (so the whole suite would skip it).
if TZ=America/Los_Angeles "$NODE" --experimental-strip-types --test lib/autoSubmitChannel.test.ts; then
  echo "  ok: autoSubmitChannel.test.ts passes"
else
  echo "  FAIL: autoSubmitChannel.test.ts failed or is missing"
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
if grep -q 'lib/autoSubmitChannel.test.ts' package.json; then
  echo "  ok: autoSubmitChannel.test.ts is in the test script"
else
  echo "  FAIL: autoSubmitChannel.test.ts not wired into package.json test script"
  fails=$((fails+1))
fi

# --- RELEVANCE: the pure function alone is not enough. If the model adds the
# module + a green test but never wires it into the routing module, BFMR still
# auto-submits. So assert on autoSubmitTracking.ts directly. This is the half a
# weak verify skips; reverting the routing edit turns these red.
echo "=== routing wired into autoSubmitTracking.ts (RELEVANCE) ==="
if grep -q 'autoSubmitChannel(' "$T"; then
  echo "  ok: $T calls autoSubmitChannel("
else
  echo "  FAIL: $T does not call autoSubmitChannel( -- BFMR still routed inline"
  fails=$((fails+1))
fi
if grep -q "from '@/lib/autoSubmitChannel'" "$T"; then
  echo "  ok: $T imports autoSubmitChannel"
else
  echo "  FAIL: $T does not import @/lib/autoSubmitChannel"
  fails=$((fails+1))
fi
# Route on the channel's exact string results (the task's required contract).
# autoSubmitTrackingForOrders needs Prisma + the @/ path alias, neither of which
# the repo's `node --test` harness can stand up, so the routing branches are
# pinned to their required literal form here rather than exercised behaviourally.
if grep -qF "channel === 'BG'" "$T"; then
  echo "  ok: $T routes BG on channel === 'BG'"
else
  echo "  FAIL: $T does not route on channel === 'BG'"
  fails=$((fails+1))
fi
if grep -qF "channel === 'BigSky'" "$T"; then
  echo "  ok: $T routes BigSky on channel === 'BigSky'"
else
  echo "  FAIL: $T does not route on channel === 'BigSky'"
  fails=$((fails+1))
fi

echo "=== BFMR auto-submit path removed from autoSubmitTracking.ts (RELEVANCE) ==="
for bad in 'bfmrTrackingMap' "import('@/lib/bfmrWeb')" 'bfmrSubmit' 'bfmrLinks'; do
  if grep -qF "$bad" "$T"; then
    echo "  FAIL: $T still contains '$bad' -- the BFMR auto-submit path was not removed"
    fails=$((fails+1))
  else
    echo "  ok: '$bad' absent"
  fi
done

echo "--- $fails failed ---"
[ "$fails" -eq 0 ] && echo VERIFY_OK || exit 1
