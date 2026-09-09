#!/usr/bin/env bash
# verify for: bfmr-link-guard (--ts-runner node-test)
# Counting idiom, NOT `set -e` -- an aborting verify never prints why it failed.
cd "$(dirname "$0")" || exit 1

fails=0
NODE=$(command -v node)     # the queue daemon runs under launchd's PATH
[ -n "$NODE" ] || { echo "  FAIL: node not on PATH"; exit 1; }

echo "=== env bootstrap ==="
# A DANGLING node_modules symlink (the scaffold linked the worktree to the
# source, then the source's node_modules went away) is `[ ! -d ]`-true, so the
# old check fell through to `npm ci`, which then errors on the pre-existing
# symlink path. Remove a broken symlink first so npm can install cleanly.
if [ -L ./node_modules ] && [ ! -e ./node_modules ]; then
  echo "  node_modules is a dangling symlink -- removing so npm can install"
  rm -f ./node_modules
fi
if [ ! -d ./node_modules ]; then
  echo "  node_modules absent -- npm ci for env parity (tsc/tests need deps)"
  if [ -f package-lock.json ]; then _NPM="npm ci"; else _NPM="npm install"; fi
  if $_NPM >/tmp/_verify_npm.$$.log 2>&1; then echo "  ok: $_NPM"; else echo "  FAIL: $_NPM failed"; tail -20 /tmp/_verify_npm.$$.log; fails=$((fails+1)); fi
  rm -f /tmp/_verify_npm.$$.log
fi
_SCHEMA=""
[ -f prisma/schema.prisma ] && _SCHEMA=prisma/schema.prisma
[ -z "$_SCHEMA" ] && _SCHEMA=$(ls prisma/schema/*.prisma 2>/dev/null | head -1)
if [ -n "$_SCHEMA" ] && grep -q "generator" "$_SCHEMA" 2>/dev/null; then
  _OUT=$(grep -oE 'output[[:space:]]*=[[:space:]]*"[^"]+"' "$_SCHEMA" | head -1 | sed -E 's/.*"([^"]+)"/\1/')
  _SDIR=$(dirname "$_SCHEMA")
  _SKIP_PRISMA=""
  case "$_OUT" in
    /*) _ABS="$_OUT" ;;
    "") _ABS="node_modules/.prisma/client"
        # Default output lands INSIDE node_modules. When that is symlinked to the
        # source checkout, `prisma generate` writes into the SOURCE repo (outside
        # this worktree, and wrong if the schemas differ). Skip rather than
        # corrupt the source -- generate in the source repo, or set a
        # worktree-local `output` in the schema's generator block.
        if [ -L node_modules ]; then _SKIP_PRISMA=1; fi ;;
    *)  _ABS="$_SDIR/$_OUT" ;;
  esac
  if [ -n "$_SKIP_PRISMA" ]; then
    echo "  WARN: node_modules is symlinked to the source; skipping default-output prisma generate (would write into the source repo). Generate there, or set a worktree-local output in the schema."
  elif [ -d "$_ABS" ] && [ -n "$(ls -A "$_ABS" 2>/dev/null)" ]; then
    echo "  ok: prisma client present ($_ABS)"
  else
    echo "  prisma client missing ($_ABS) -- npx prisma generate"
    if npx --yes prisma generate >/tmp/_verify_prisma.$$.log 2>&1; then echo "  ok: prisma generate"; else echo "  WARN: prisma generate failed (continuing; tsc may flood with TS7006)"; tail -20 /tmp/_verify_prisma.$$.log; fi
    rm -f /tmp/_verify_prisma.$$.log
  fi
fi

if [ -x ./node_modules/.bin/tsx ]; then TSX="./node_modules/.bin/tsx"; else TSX="npx --yes tsx"; fi
if [ -x ./node_modules/.bin/tsc ]; then TSC="./node_modules/.bin/tsc"; else TSC="npx --yes tsc"; fi

# The new/edited test file(s) this dispatch's fix must make pass.
TEST_FILES="lib/bfmrLinkGuard.test.ts"

RUNNER="$NODE --experimental-strip-types --test"
echo "  runner: node --experimental-strip-types --test (pure module, relative import -- deterministic, no tsx/npx)"


echo "=== target parses ==="
if "$NODE" '/Users/penn/bin/ts-mutator/ts-parse.mjs' 'lib/bfmrLinkGuard.ts' 2>/tmp/_verify_parse.$$.log; then
  echo "  ok: lib/bfmrLinkGuard.ts parses"
elif grep -qiE "ERR_MODULE_NOT_FOUND|Cannot find (package|module) 'typescript'" /tmp/_verify_parse.$$.log; then
  echo "  WARN: ts-parse sidecar not installed (needs 'typescript' in bin/ts-mutator) -- relying on tsc --noEmit below"
else
  echo "  FAIL: lib/bfmrLinkGuard.ts does not parse"; head -5 /tmp/_verify_parse.$$.log; fails=$((fails+1))
fi
rm -f /tmp/_verify_parse.$$.log

echo "=== types (tsc --noEmit) ==="
if $TSC --noEmit -p tsconfig.json >/tmp/_verify_tsc.$$.log 2>&1; then
  echo "  ok: tsc --noEmit clean"
elif grep -qE '(lib/bfmrLinkGuard|lib/bfmrAutoLink|app/api/bfmr/links/route)\.ts[(:]' /tmp/_verify_tsc.$$.log; then
  echo "  FAIL: tsc --noEmit reports errors in an edited/created file"; grep -E '(lib/bfmrLinkGuard|lib/bfmrAutoLink|app/api/bfmr/links/route)\.ts[(:]' /tmp/_verify_tsc.$$.log | head -15; fails=$((fails+1))
else
  echo "  WARN: tsc --noEmit has pre-existing errors OUTSIDE the edited files (not this task's) -- passing type gate"
fi
rm -f /tmp/_verify_tsc.$$.log

echo "=== spec literals ==="
if python3 ./check_literals.py; then
  echo "  ok: every Must-contain literal present"
else
  echo "  FAIL: a Must-contain literal is missing"; fails=$((fails+1))
fi

echo "=== behavioural tests ($RUNNER) ==="
# The adversarial cases live in the repo's OWN test file(s), authored by you and
# copied in -- the model is told not to edit them (SHA-checked like any fixture).
# `node --test` with ZERO tests exits 0 (green-on-nothing), so -- matching the
# Python/Swift `>= 3` discipline -- we also require >= 3 tests actually RAN, read
# from the TAP `# tests N` summary line.
if [ -z "$TEST_FILES" ]; then
  echo "  SCAFFOLD_INCOMPLETE: no TEST_FILES set -- name the new/edited test file(s) in verify.sh"; fails=$((fails+1))
else
  _tout=$($RUNNER $TEST_FILES 2>&1); _trc=$?
  echo "$_tout" | tail -30
  _ntests=$(printf '%s
' "$_tout" | grep -oE '^# tests [0-9]+' | grep -oE '[0-9]+' | tail -1)
  [ -z "$_ntests" ] && _ntests=0
  if [ "$_trc" -ne 0 ]; then
    echo "  FAIL: new test file(s) failed (exit $_trc)"; fails=$((fails+1))
  elif [ "$_ntests" -lt 3 ]; then
    echo "  SCAFFOLD_INCOMPLETE: only $_ntests test(s) ran; need >= 3 (a passing suite of 0 tests is vacuous)"; fails=$((fails+1))
  else
    echo "  ok: new test file(s) pass ($_ntests tests)"
  fi
fi

echo "=== wiring: guardLink defined in the pure module and called at every write site ==="
if grep -q 'export function guardLink' lib/bfmrLinkGuard.ts && grep -q 'export function normTracking' lib/bfmrLinkGuard.ts; then
  echo "  ok: lib/bfmrLinkGuard.ts exports guardLink + normTracking"
else
  echo "  FAIL: lib/bfmrLinkGuard.ts must export guardLink AND normTracking"; fails=$((fails+1))
fi
if grep -q "from './bfmrLinkGuard" lib/bfmrAutoLink.ts && grep -q 'guardLink(' lib/bfmrAutoLink.ts; then
  echo "  ok: bfmrAutoLink.ts imports and calls guardLink"
else
  echo "  FAIL: lib/bfmrAutoLink.ts must import guardLink from './bfmrLinkGuard' and call it at its create site"; fails=$((fails+1))
fi
if grep -qE "import \{[^}]*guardLink[^}]*\} from '@/lib/bfmrLinkGuard'" app/api/bfmr/links/route.ts && grep -q 'guardLink(' app/api/bfmr/links/route.ts; then
  echo "  ok: route.ts imports and calls guardLink"
else
  echo "  FAIL: app/api/bfmr/links/route.ts must import guardLink from '@/lib/bfmrLinkGuard' and call it before create/update"; fails=$((fails+1))
fi

echo "=== repo suite (npm test, WARN-only) ==="
# A broader safety net. WARN not FAIL: a repo suite is often red at baseline for
# reasons this task never touched, so it cannot gate; the scoped TEST_FILES above
# are the authoritative behavioural pin. Set REPO_TEST=skip to silence.
if [ "${REPO_TEST:-run}" = "skip" ]; then
  echo "  (skipped)"
elif ! grep -q '"test"' package.json 2>/dev/null; then
  echo "  (no npm test script)"
elif npm test --silent >/tmp/_verify_npmtest.$$.log 2>&1; then
  echo "  ok: npm test green"
else
  echo "  WARN: npm test not green (may be pre-existing -- scoped tests above gate)"; tail -15 /tmp/_verify_npmtest.$$.log
fi
rm -f /tmp/_verify_npmtest.$$.log

echo "--- $fails failed ---"
[ "$fails" -eq 0 ] && echo VERIFY_OK || exit 1
